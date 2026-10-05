// Subagents (spec §9), on durable's background-subagent pattern (pi-durable example 23).
//
// spawn(tasks) starts one child conversation per task. Each child is owned by an anchor: a background task that ends
// at once, so the main agent's Esc and idle waits never reach the child. A reporter task delivers each message to a
// child and records the answer. When every member of a spawn has answered, one commit puts a single combined report
// ("[a1] ...\n\n[a2] ...") in the outbox. The brain moves outbox items into its turn queue (or steers them into the
// running turn), so a report that starts a turn gets a fresh view like any user message.

import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, type ModelThinkingLevel, Type, type UserMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";
import { SPAWN_DESCRIPTION, TELL_DESCRIPTION } from "../core/prompts.ts";

type Content = UserMessage["content"];

export type AgentRecord = {
	conversationId: ConversationId;
	task: string;
	/** The spawn (or tell) that started it. */
	group: string;
	/** Answers already reported: several messages can end in one answer, reported once. */
	reported: EntryId[];
}

type Group = {
	members: string[];
	/** null: nothing to report for that member (an answer already reported). */
	reports: Record<string, string | null>;
}

export type OutboxItem = {
	id: string;
	text: string;
}

export type SubagentsState = {
	next: number;
	agents: Record<string, AgentRecord>;
	groups: Record<string, Group>;
	outbox: OutboxItem[];
}

export const SubagentsDoc = defineDoc<SubagentsState>({
	kind: "saavy.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ next: 0, agents: {}, groups: {}, outbox: [] }),
});

export interface SubagentOptions {
	/** The model subagents run with; undefined: the main agent's. */
	readonly model: () => ModelRef | undefined;
	readonly thinking: () => ModelThinkingLevel | undefined;
}

const terminal = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const background = { ownership: { kind: "conversation" }, background: true } as const;

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "saavy.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(() => terminal, context) },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
}

type ReporterInput = { name: string; conversationId: ConversationId; content: Content; group: string };

const Reporter = defineTask<ReporterInput, { phase: "deliver" }, null>({
	name: "saavy.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const { name, conversationId, content, group } = reporter.input;
			const child = await runtime.conversation(conversationId, context);
			// The request ID makes a resumed delivery find its first submission instead of sending twice.
			const request = { type: "input", content, whenBusy: "steer", requestId: `saavy-subagent:${reporter.id}` } as const;
			const settled = child === undefined ? undefined : await (await child.submit(request, context)).wait(context);
			await runtime.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, runtime.conversationId);
				const agent = state.agents[name];
				let report: string | null = null;
				if (settled === undefined) report = "(its conversation is gone)";
				else if (settled.status === "unanswered") {
					report = settled.reason === "aborted" ? "(stopped)" : `(failed: ${settled.reason})`;
				} else if (settled.type === "input" && agent !== undefined && !agent.reported.includes(settled.answer)) {
					agent.reported.push(settled.answer);
					const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
					report = textOf(answer) || "(no answer text)";
				}
				const entry = state.groups[group];
				if (entry !== undefined) {
					entry.reports[name] = report;
					if (entry.members.every((member) => Object.hasOwn(entry.reports, member))) {
						const parts = entry.members.flatMap((member) => {
							const text = entry.reports[member];
							return text === null || text === undefined ? [] : [`[${member}] ${text}`];
						});
						if (parts.length > 0) state.outbox.push({ id: group, text: parts.join("\n\n") });
						delete state.groups[group];
					}
				}
				return terminal;
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Send `content` to subagent `name` as group `group`; false when there is no such subagent. Idempotent per group. */
export async function tellIn(tx: Tx, rootId: ConversationId, name: string, content: Content, group: string): Promise<boolean> {
	const state = await tx.doc(SubagentsDoc, rootId);
	const agent = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
	if (agent === undefined) return false;
	if (Object.hasOwn(state.groups, group)) return true;
	state.groups[group] = { members: [name], reports: {} };
	await tx.createTask(Reporter, { name, conversationId: agent.conversationId, content, group }, background);
	return true;
}

export interface SpawnView {
	/** Wait (at most 20 s) for the view's lines to be summaries, building them; false when aborted. */
	settle(signal: AbortSignal | undefined): Promise<boolean | "late">;
	render(): string;
}

export function createSubagentTools(view: SpawnView, extensions: () => readonly Extension[], options: SubagentOptions): Extension {
	const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
	return defineExtension({
		name: "saavy-subagents",
		tasks: [Anchor, Reporter],
		tools: [
			defineTool({
				name: "spawn",
				description: SPAWN_DESCRIPTION,
				parameters: Type.Object({ tasks: Type.Array(Type.String(), { minItems: 1 }) }),
				// A rerun finds the subagents this call already started.
				replay: "safe",
				execute: async (args, api, context: Context) => {
					const started = (await api.snapshot(SubagentsDoc, api.conversationId, context))?.agents ?? {};
					const prior = Object.keys(started).filter((name) => started[name]!.group === String(api.taskId));
					if (prior.length > 0) return reply(`Started ${prior.join(", ")}.`);
					// A subagent's first message is the view at spawn time, once every line is a summary.
					// Waits like a turn, at most 20 s; lines still pending go out as placeholders.
					if (!(await view.settle(context.abortSignal))) return { ...reply("Aborted before starting."), isError: true };
					const rendered = view.render();
					const names = await api.commit(async (tx) => {
						const state = await tx.doc(SubagentsDoc, api.conversationId);
						const names: string[] = [];
						for (const task of args.tasks) {
							const name = `a${++state.next}`;
							const anchor = await tx.createTask(Anchor, null, background);
							// Starts as a copy of the main agent: model, thinking level, working directory.
							const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
							const model = options.model();
							const thinking = options.thinking();
							await configure(tx, child.id, {
								extensions: [...extensions()],
								...(model === undefined ? {} : { model }),
								...(thinking === undefined ? {} : { thinkingLevel: thinking }),
							});
							state.agents[name] = { conversationId: child.id, task, group: String(api.taskId), reported: [] };
							const content: Content = [
								{ type: "text", text: rendered },
								{ type: "text", text: task },
							];
							await tx.createTask(Reporter, { name, conversationId: child.id, content, group: String(api.taskId) }, background);
							names.push(name);
						}
						state.groups[String(api.taskId)] = { members: names, reports: {} };
						return names;
					}, context);
					return reply(`Started ${names.join(", ")}. Their reports will arrive together as one message.`);
				},
			}),
			defineTool({
				name: "tell",
				description: TELL_DESCRIPTION,
				parameters: Type.Object({ id: Type.String(), message: Type.String() }),
				replay: "safe",
				execute: async (args, api, context) => {
					const sent = await api.commit(
						(tx) => tellIn(tx, api.conversationId, args.id, args.message, String(api.taskId)),
						context,
					);
					return sent ? reply(`Sent to ${args.id}.`) : { ...reply(`No subagent ${args.id}.`), isError: true };
				},
			}),
		],
	});
}
