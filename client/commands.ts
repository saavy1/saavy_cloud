// Slash commands. Each has a usage line, help, optional tab completion of its arguments, and a run function.
// Settings live in the brain; commands for what the brain does not do yet (subagents, MCP, provider logins) are left
// out rather than half-working.

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { RemoteSaavy, Thinking } from "./remote.ts";

export interface Ui {
	readonly saavy: RemoteSaavy;
	print(message: string): void;
	ask(message: string, secret: boolean): Promise<string>;
	choose(message: string, options: { id: string; label: string }[]): Promise<string>;
	/** Compose a message in $EDITOR; undefined when left empty. */
	edit(initial?: string): Promise<string | undefined>;
	send(text: string): void;
	quit(): void;
	/** Empty the screen for a fresh start; memory is untouched. */
	clear(): void;
	/** The filterable model picker. */
	pickModel(): Promise<void>;
	/** Walk the memory tree. */
	explore(): void;
	/** A titled, foldable markdown document in the transcript. */
	showDoc(title: string, markdown: string): void;
}

export interface Command {
	readonly name: string;
	readonly usage: string;
	readonly help: string;
	/** Completions for the argument text typed so far. */
	complete?(saavy: RemoteSaavy, args: string): string[];
	run(ui: Ui, args: string): Promise<void>;
}

const THINKING: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const keyOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

const modelKeys = (saavy: RemoteSaavy, prefix: string): string[] =>
	saavy.models
		.getAvailableSnapshot()
		.map(keyOf)
		.filter((key) => key.startsWith(prefix));

/** Models whose key or name holds every word of `query`; an exact key wins outright. */
function findModels(saavy: RemoteSaavy, query: string): Model<Api>[] {
	const all = saavy.models.getAvailableSnapshot();
	const exact = all.find((model) => keyOf(model) === query);
	if (exact !== undefined) return [exact];
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return all.filter((model) => words.every((word) => `${keyOf(model)} ${model.name}`.toLowerCase().includes(word)));
}

/** Resolve a model query to one available model, asking when several match. */
async function pickModel(ui: Ui, query: string): Promise<string | undefined> {
	const matches = findModels(ui.saavy, query);
	if (matches.length === 0) {
		ui.print(`No model matches "${query}".`);
		return undefined;
	}
	if (matches.length === 1) return keyOf(matches[0]!);
	const shown = matches.slice(0, 30);
	const choice = await ui.choose(
		`${matches.length} models match${matches.length > shown.length ? " (first 30 shown; narrow the query)" : ""}:`,
		shown.map((model) => ({ id: keyOf(model), label: `${keyOf(model)}  ${model.name}` })),
	);
	return choice || undefined;
}

const splitKey = (key: string) => {
	const slash = key.indexOf("/");
	return { provider: key.slice(0, slash), modelId: key.slice(slash + 1) };
};

export const commands: Command[] = [
	{
		name: "help",
		usage: "/help",
		help: "List commands",
		run: async (ui) => {
			const width = Math.max(...commands.map((command) => command.usage.length));
			ui.print(commands.map((command) => `${command.usage.padEnd(width)}  ${command.help}`).join("\n"));
			ui.print("Ctrl+C aborts the turn (or clears the line); Ctrl+D quits. !cmd runs a command here and logs it; !!cmd does not log.");
		},
	},
	{
		name: "model",
		usage: "/model [query]",
		help: "Show or switch the main model",
		complete: (saavy, args) => modelKeys(saavy, args),
		run: async (ui, args) => {
			if (args === "") return ui.pickModel();
			const key = await pickModel(ui, args);
			if (key === undefined) return;
			const thinking = await ui.saavy.setModel(splitKey(key));
			ui.print(`main model: ${key} (thinking ${thinking})`);
		},
	},
	{
		name: "thinking",
		usage: "/thinking [level]",
		help: "Show or set the main model's thinking level",
		complete: (_saavy, args) => THINKING.filter((level) => level.startsWith(args)),
		run: async (ui, args) => {
			const agent = await ui.saavy.agent();
			const model = agent.model === undefined ? undefined : ui.saavy.models.getModel(agent.model.provider, agent.model.modelId);
			const levels = model === undefined ? THINKING : ["off", ...getSupportedThinkingLevels(model).filter((l) => l !== "off")];
			if (args === "") {
				ui.print(`thinking: ${agent.thinkingLevel ?? "default"} (supported: ${levels.join(", ")})`);
				return;
			}
			if (!THINKING.includes(args as Thinking)) return ui.print(`Levels: ${THINKING.join(", ")}`);
			ui.print(`thinking: ${await ui.saavy.setThinking(args as ModelThinkingLevel)}`);
		},
	},
	{
		name: "compactor",
		usage: "/compactor [model] [thinking]",
		help: "Show or set the model that writes summaries (a cheap, fast one is best)",
		complete: (saavy, args) => {
			const words = args.split(" ");
			if (words.length <= 1) return modelKeys(saavy, args);
			const prefix = words.slice(0, -1).join(" ");
			return THINKING.filter((level) => level.startsWith(words.at(-1)!)).map((level) => `${prefix} ${level}`);
		},
		run: async (ui, args) => {
			if (args === "") {
				const { compactor } = ui.saavy.config;
				ui.print(`compactor: ${compactor.model} (thinking ${compactor.thinking})`);
				return;
			}
			const words = args.split(/\s+/).filter(Boolean);
			const last = words.at(-1) as Thinking | undefined;
			const thinking = last !== undefined && THINKING.includes(last) ? last : undefined;
			const query = (thinking === undefined ? words : words.slice(0, -1)).join(" ");
			const model = query === "" ? undefined : await pickModel(ui, query);
			if (query !== "" && model === undefined) return;
			await ui.saavy.setCompactor(model, thinking);
			ui.print(`compactor: ${ui.saavy.config.compactor.model} (thinking ${ui.saavy.config.compactor.thinking})`);
		},
	},
	{
		name: "cwd",
		usage: "/cwd [dir]",
		help: "Show or change the directory the agent works in (on the desktop)",
		run: async (ui, args) => {
			if (args === "") return ui.print((await ui.saavy.agent()).cwd ?? ui.saavy.config.cwd);
			ui.print(`cwd: ${await ui.saavy.setCwd(args)}`);
		},
	},
	{
		name: "usage",
		usage: "/usage",
		help: "Tokens and cost so far, per model",
		run: async (ui) => {
			const usage = await ui.saavy.usage();
			const lines = Object.entries(usage.models ?? {}).map(
				([model, u]) => `${model}: in ${u.input}, out ${u.output}, cache read ${u.cacheRead}, write ${u.cacheWrite}, $${u.cost.total.toFixed(4)}`,
			);
			ui.print(lines.length === 0 ? "No usage yet." : lines.join("\n"));
		},
	},
	{
		name: "edit",
		usage: "/edit",
		help: "Compose a message in $EDITOR",
		run: async (ui) => {
			const text = await ui.edit();
			if (text !== undefined) ui.send(text);
		},
	},
	{
		name: "view",
		usage: "/view",
		help: "Print the view the agent sees",
		run: async (ui) => ui.print(await ui.saavy.memory.view()),
	},
	{
		name: "zoom",
		usage: "/zoom <id> [n]",
		help: "Open a line of the view (n = 1: the whole message)",
		run: async (ui, args) => {
			const [id, n] = args.split(/\s+/);
			ui.print(await ui.saavy.memory.zoom(Number(id), Number(n ?? 1)));
		},
	},
	{
		name: "memory",
		usage: "/memory",
		help: "Explore the memory: the view's lines, opening down the tree to the messages",
		run: async (ui) => ui.explore(),
	},
	{
		name: "search",
		usage: "/search <words>",
		help: "Find messages containing the words, verbatim",
		run: async (ui, args) => ui.print(await ui.saavy.memory.search(args)),
	},
	{
		name: "date",
		usage: "/date <id>",
		help: "When message id was written",
		run: async (ui, args) => ui.print(await ui.saavy.memory.date(Number(args))),
	},
	{
		name: "status",
		usage: "/status",
		help: "Memory, models, the brain and the desktop runner",
		run: async (ui) => {
			const { memory, config } = ui.saavy;
			const agent = await ui.saavy.agent();
			const hello = await ui.saavy.call<{ runners: number }>("hello");
			const s = memory.stats;
			ui.print(
				[
					`main ${agent.model === undefined ? "none" : keyOf({ provider: agent.model.provider, id: agent.model.modelId })} (thinking ${agent.thinkingLevel ?? "default"}), cwd ${agent.cwd ?? config.cwd}`,
					`compactor ${config.compactor.model} (thinking ${config.compactor.thinking})`,
					`${s.messages} messages, ${s.summaries} summaries, view ${s.viewLines} lines, ${s.unbuilt} unsummarized, ${s.compacting} compactor jobs`,
					`desktop runner: ${hello.runners > 0 ? "connected" : "offline"}`,
				].join("\n"),
			);
		},
	},
	{
		name: "clear",
		usage: "/clear",
		help: "Start fresh: clear the screen (memory keeps everything; the agent is told you started over)",
		run: async (ui) => clearScreen(ui),
	},
	{
		name: "new",
		usage: "/new",
		help: "Same as /clear",
		run: async (ui) => clearScreen(ui),
	},
	{
		name: "quit",
		usage: "/quit",
		help: "Exit; work in flight carries on in the brain",
		run: async (ui) => ui.quit(),
	},
];

/** The marker a fresh start leaves in the log; front ends draw it as a divider, not a message. */
export const CLEARED = "[The user cleared the screen to start fresh. Everything before is still in memory; don't assume the next message continues the last topic.]";

async function clearScreen(ui: Ui): Promise<void> {
	ui.clear();
	await ui.saavy.note(CLEARED);
}

/** Subagent ids for completion; the brain has no subagents yet. */
export function setAgentIds(_ids: string[]): void {}

export function findCommand(name: string): Command | undefined {
	return commands.find((command) => command.name === name);
}
