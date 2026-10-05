// The brain's OptChat extension: the system prompt, zoom / search / date over memory, and the hook that gives each
// turn its view. Each turn is a fresh call (spec §7): the turn queue resets the conversation before submitting and
// stores the view rendered before the new message in `saavy.turn`; the hook puts it in front of the run's first user
// message on every request of the run, so the prefix stays byte-identical and cached, also after an eviction.
import type { Context } from "@earendil-works/chord";
import { type Message, Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type Extension, GenerationTask, hook, ROOT_CONVERSATION_ID, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Memory } from "../core/memory.ts";
import { DATE_DESCRIPTION, MASTER, SEARCH_DESCRIPTION, VIEW_DOC, ZOOM_DESCRIPTION } from "../core/prompts.ts";

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
}

/**
 * The user's own instructions: every AGENTS.md from the root down to the working directory, more specific last, read
 * on the desktop. When the runner is offline the last copy read stands in.
 */
async function instructions(env: ExecutionEnv | undefined, cache: InstructionsCache, context: Context): Promise<string> {
	if (env === undefined) return cache.get() ?? "The user has written no instructions file yet.";
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

export function createExtensions(memory: () => Memory, cache: InstructionsCache): Extension[] {
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
		sections: [
			section("preamble", () => MASTER, { tag: false }),
			section("view", () => VIEW_DOC, { tag: false }),
			section("cwd", (input) => input.env?.cwd),
			section("user_instructions", (input, context) => instructions(input.env, cache, context)),
		],
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
	return [Memory, Master];
}
