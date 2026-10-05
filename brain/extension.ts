// The brain's OptChat extension: the system prompt, zoom / search / date over memory, and the hook that gives each
// turn its view. Each turn is a fresh call (spec §7): the turn queue resets the conversation before submitting and
// stores the view rendered before the new message in `saavy.turn`; the hook puts it in front of the run's first user
// message on every request of the run, so the prefix stays byte-identical and cached, also after an eviction.
import type { Context } from "@earendil-works/chord";
import { type Message, Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type Extension, GenerationTask, hook, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Memory } from "../core/memory.ts";
import { DATE_DESCRIPTION, MASTER, SEARCH_DESCRIPTION, SUBAGENT, VIEW_DOC, ZOOM_DESCRIPTION } from "../core/prompts.ts";
import { checkUi, checkUpdate, SHOW_DESCRIPTION, UI_REFERENCE, type UiNode, type UiUpdate, UPDATE_DESCRIPTION } from "../core/ui.ts";

export const TurnDoc = defineDoc<{ view: string }>({
	kind: "saavy.turn",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ view: "" }),
});

/** Put the view in front of the first user message of the run, as its own text block. */
export function withView(messages: readonly Message[], view: string): Message[] {
	const index = messages.findIndex((message) => message.role === "user");
	if (index < 0 || view === "") return [...messages];
	const user = messages[index] as Extract<Message, { role: "user" }>;
	const content = typeof user.content === "string" ? [{ type: "text" as const, text: user.content }] : user.content;
	const out = [...messages];
	out[index] = { ...user, content: [{ type: "text", text: view }, ...content] };
	return out;
}

export interface InstructionsCache {
	get(): string | undefined;
	set(text: string): void;
	/** Whether a runner is connected now; without one the cached copy stands in at once. */
	online(): boolean;
}

/**
 * The user's own instructions: every AGENTS.md from the root down to the working directory, more specific last, read
 * on the desktop. When the runner is offline the last copy read stands in.
 */
async function instructions(env: ExecutionEnv | undefined, cache: InstructionsCache, context: Context): Promise<string> {
	if (env === undefined || !cache.online()) return cache.get() ?? "The user has written no instructions file yet.";
	const dirs: string[] = [];
	for (let dir: string | undefined = env.cwd; dir !== undefined; ) {
		dirs.unshift(dir);
		const parent: string = dir.replace(/\/[^/]+\/?$/, "") || "/";
		dir = parent === dir ? undefined : parent;
	}
	const texts: string[] = [];
	for (const dir of dirs) {
		const path = `${dir === "/" ? "" : dir}/AGENTS.md`;
		const exists = await env.exists(path, context);
		if (!exists.ok) return cache.get() ?? "The desktop is offline, so the user's instructions files cannot be read now.";
		if (!exists.value) continue;
		const text = await env.readTextFile(path, context);
		if (text.ok) texts.push(`<file path="${path}">\n${text.value.trim()}\n</file>`);
	}
	const result = texts.length === 0 ? "The user has written no instructions file yet." : texts.join("\n\n");
	if (result !== cache.get()) cache.set(result);
	return result;
}

export interface OptChatExtensions {
	/** zoom, search, date: for the main agent and its subagents. */
	readonly memory: Extension;
	/** The main agent's prompt and the hook that gives each turn its view. */
	readonly master: Extension;
	/** A subagent's prompt (its view arrives in its first message). */
	readonly sub: Extension;
	/**
	 * show, update_ui, ui_reference: the brain only checks a spec; front ends draw it from the transcript (the call's
	 * arguments), each as well as it can.
	 */
	readonly ui: Extension;
}

export function createExtensions(memory: () => Memory, cache: InstructionsCache): OptChatExtensions {
	const prompt = (preamble: string) => [
		section("preamble", () => preamble, { tag: false }),
		section("view", () => VIEW_DOC, { tag: false }),
		section("cwd", (input) => input.env?.cwd),
		section("user_instructions", (input, context) => instructions(input.env, cache, context)),
	];
	const Memory = defineExtension({
		name: "saavy-memory",
		tools: [
			defineTool({
				name: "zoom",
				description: ZOOM_DESCRIPTION,
				parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
				replay: "safe",
				execute: async (args) => ({ content: [{ type: "text", text: memory().zoom(args.id, args.n) }] }),
			}),
			defineTool({
				name: "search",
				description: SEARCH_DESCRIPTION,
				parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer()) }),
				replay: "safe",
				execute: async (args) => ({
					content: [
						{
							type: "text",
							text: memory().search(args.query, {
								...(args.kind === undefined ? {} : { kind: args.kind }),
								...(args.limit === undefined ? {} : { limit: args.limit }),
							}),
						},
					],
				}),
			}),
			defineTool({
				name: "date",
				description: DATE_DESCRIPTION,
				parameters: Type.Object({ id: Type.Integer() }),
				replay: "safe",
				execute: async (args) => ({ content: [{ type: "text", text: memory().date(args.id) }] }),
			}),
		],
	});
	const Master = defineExtension({
		name: "saavy",
		sections: prompt(MASTER),
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api, context) => {
					if (api.conversationId !== ROOT_CONVERSATION_ID) return undefined;
					const turn = await api.snapshot(TurnDoc, api.conversationId, context);
					return { messages: withView(request.messages, turn?.view ?? "") };
				},
			}),
		],
	});
	const Sub = defineExtension({ name: "saavy-subagent", sections: prompt(SUBAGENT) });
	const Ui = defineExtension({
		name: "saavy-ui",
		tools: [
			defineTool({
				name: "show",
				description: SHOW_DESCRIPTION,
				parameters: Type.Object({
					handle: Type.String({ description: "A short name for this UI, [A-Za-z0-9_-]." }),
					title: Type.Optional(Type.String()),
					placement: Type.Optional(
						Type.Union([Type.Literal("inline"), Type.Literal("panel"), Type.Literal("panel-down")], {
							description: "inline (default): in the transcript. panel / panel-down: a pane beside / below the chat where the client has panes (Tern); elsewhere inline.",
						}),
					),
					ui: Type.Unsafe<UiNode>({ type: "object", description: "One node: { k, id?, p?, c? }." }),
				}),
				replay: "safe",
				execute: async (args) => {
					if (!/^[A-Za-z0-9_-]{1,40}$/.test(args.handle)) return { content: [{ type: "text", text: "handle must be 1-40 characters of [A-Za-z0-9_-]" }], isError: true };
					const error = checkUi(args.ui);
					if (error !== undefined) return { content: [{ type: "text", text: `Not shown: ${error}` }], isError: true };
					return { content: [{ type: "text", text: `Shown as "${args.handle}". Clicks (in clients that have them) reach you as messages starting "[ui ${args.handle}]".` }] };
				},
			}),
			defineTool({
				name: "update_ui",
				description: UPDATE_DESCRIPTION,
				parameters: Type.Object({
					handle: Type.String(),
					set: Type.Optional(Type.Array(Type.Object({ id: Type.String(), props: Type.Record(Type.String(), Type.Unknown()) }))),
					append: Type.Optional(Type.Array(Type.Object({ id: Type.String(), text: Type.String() }))),
					ui: Type.Optional(Type.Unsafe<UiNode>({ type: "object" })),
				}),
				replay: "safe",
				execute: async (args) => {
					const error = checkUpdate(args as UiUpdate);
					if (error !== undefined) return { content: [{ type: "text", text: `Not updated: ${error}` }], isError: true };
					return { content: [{ type: "text", text: `Updated "${args.handle}".` }] };
				},
			}),
			defineTool({
				name: "ui_reference",
				description: "The props of one UI kind, for show and update_ui.",
				parameters: Type.Object({ kind: Type.String() }),
				replay: "safe",
				execute: async (args) => ({
					content: [{ type: "text", text: UI_REFERENCE[args.kind] ?? `No details for "${args.kind}". Kinds with details: ${Object.keys(UI_REFERENCE).join(", ")}.` }],
				}),
			}),
		],
	});
	return { memory: Memory, master: Master, sub: Sub, ui: Ui };
}
