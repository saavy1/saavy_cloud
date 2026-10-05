// saavy in Tern, drawn natively over the Tern Surface Protocol: one inline surface, the transcript in `main`, the
// working row, subagents, composer, and status bar in `dock`, pickers and questions in `layer`.
//
// The same sources as the pi-tui front end: entries from the host's commit stream (across the per-turn resets),
// streaming partials and running tools from the main conversation's view state, skipped when older than the screen.
// Ops are emitted directly; the transcript only appends and updates known nodes, so no tree diffing is needed.
// The agent itself is the brain on Cloudflare (RemoteSaavy); this process draws it and runs the desktop runner.

import { execFile, spawn, spawnSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { AgentState, ConversationView, EntryRecord, LiveState, UsageState } from "@earendil-works/pi-durable";
import { CombinedAutocompleteProvider, fuzzyFilter, matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { cap } from "../../core/log.ts";
import { VIEW } from "../../core/view.ts";
import type { RemoteSaavy as Saavy } from "../remote.ts";
import { CLEARED, commands, findCommand, setAgentIds, type Ui } from "../commands.ts";
import { checkUi, type UiNode, type UiUpdate } from "../../core/ui.ts";
import { toWire } from "./render.ts";
import { EditorModel } from "./editor.ts";
import { MemoryExplorer } from "./explorer.ts";
import { splashNode } from "./splash.ts";
import { type Handshake, type Op, Surface } from "./surface.ts";

const context = BACKGROUND_CONTEXT;
/** The panel program: a Tern pane that draws one agent UI. */
const PANEL_BIN = join(import.meta.dirname, "..", "..", "bin", "saavy-panel");

// Node shapes and roles follow oh-my-pi's (omp.user, omp.assistant, omp.thinking, omp.tool.*, omp.working, and the
// omp.editor composer with its line and chip bar), which Tern's built-in sheets and chat skins (Reader, Spine,
// Console) are drawn for: a centered measure, a glass composer, user bubbles, quiet tool rows.

const userText = (content: UserMessage["content"]): string =>
	typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");

const formatTokens = (n: number): string =>
	n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

function totalUsage(state: UsageState | undefined): { input: number; output: number; cacheRead: number; cost: number } {
	const total = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})] as Usage[]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cost += usage.cost.total;
	}
	return total;
}

/** Ids saavy gives its fixed nodes; generated ids never collide with them. */
export const FIXED_IDS = [
	"main", "dock", "layer", "ag", "wk", "wks", "wke", "toast", "cmp", "cmp.line", "cmp.bar", "cm", "cm.i", "cm.n",
	"cm.c", "ce", "ce.g", "ce.t", "cmem", "cmem.m", "cmem.t", "cmem.s", "cgap", "cu", "csend", "cstop", "st", "scwd", "smem", "ed", "ed.ac", "ed.acl",
];

export const generatedId = (prefix: string, n: number): string => `_${prefix}${n.toString(36)}`;

/** How a tool call is headed: Tern's icon name, the verb, and its main argument. */
function toolHead(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const str = (value: unknown) => (typeof value === "string" ? value : undefined);
	switch (name) {
		case "bash":
			return { name: "bash", title: "Run", target: str(args.command), targetKind: "command" };
		case "read":
			return { name: "read", title: "Read", target: str(args.path), targetKind: "path" };
		case "edit":
			return { name: "edit", title: "Edit", target: str(args.path), targetKind: "path" };
		case "write":
			return { name: "write", title: "Write", target: str(args.path), targetKind: "path" };
		case "zoom":
			return { name: "search", title: "Zoom", target: args.id === undefined ? undefined : `${args.id}+${args.n ?? 1}`, targetKind: "text" };
		case "show":
			return { name: "show", title: str(args.title) ?? "UI", target: str(args.handle), targetKind: "text" };
		case "update_ui":
			return { name: "show", title: "Update", target: str(args.handle), targetKind: "text" };
		case "ui_reference":
			return { name: "show", title: "UI reference", target: str(args.kind), targetKind: "text" };
		case "codemode": {
			const code = str(args.code) ?? "";
			const lines = code === "" ? 0 : code.split("\n").length;
			return { name: "eval", title: "Script", target: lines > 0 ? `${lines} line${lines === 1 ? "" : "s"} of JavaScript` : undefined, targetKind: "text" };
		}
		case "search":
			return { name: "search", title: "Search", target: str(args.query), targetKind: "query" };
		case "date":
			return { name: "todo", title: "Date of", target: args.id === undefined ? undefined : String(args.id), targetKind: "text" };
		case "spawn": {
			const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0;
			return { name: "task", title: "Spawn", target: tasks > 0 ? `${tasks} subagent${tasks === 1 ? "" : "s"}` : undefined, targetKind: "text" };
		}
		case "tell":
			return { name: "task", title: "Tell", target: str(args.id), targetKind: "text" };
		default:
			return { name, title: name };
	}
}

interface TextBlock {
	readonly id: string;
	/** The md node holding the text (for thinking, inside its section). */
	readonly md: string;
	readonly thinking: boolean;
	sent: string;
}

interface ToolCard {
	readonly id: string;
	readonly body: string;
	readonly name: string;
	args: Record<string, unknown>;
	started?: number;
	sent: string;
	done: boolean;
}

/** saavy's own tools that answer in a line: drawn inline, the answer as the head's note. */
const INLINE_TOOLS = new Set(["date", "tell"]);

/** `id+n|text` lines (zoom and search results) as key/value rows. */
function lineItems(text: string): { k: string; v: string }[] {
	return text.split("\n").flatMap((line) => {
		const match = /^(\d+\+\d+)\|([\s\S]*)$/.exec(line);
		return match === null ? [] : [{ k: match[1]!, v: match[2]! }];
	});
}

/** A filterable list in `layer` (Tern's `picker`), driven by keys and clicks. */
class PickerModal {
	readonly #app: SaavyTsp;
	readonly id: string;
	readonly #items: { value: string; label: string; description?: string }[];
	readonly #resolve: (value: string) => void;
	#query = "";
	#order: string[];
	#selected: string | undefined;

	constructor(app: SaavyTsp, id: string, title: string, items: { value: string; label: string; description?: string }[], resolve: (value: string) => void) {
		this.#app = app;
		this.id = id;
		this.#items = items;
		this.#resolve = resolve;
		this.#order = items.map((item) => item.value);
		this.#selected = this.#order[0];
		app.op([
			"add",
			id,
			"layer",
			null,
			{
				id,
				k: "picker",
				p: {
					size: "md",
					title,
					query: "",
					cursor: 0,
					placeholder: "Type to filter",
					noun: "item",
					items: items.map((item) => ({ id: item.value, label: item.label, ...(item.description ? { detail: item.description } : {}) })),
					order: this.#order,
					...(this.#selected === undefined ? {} : { selected: this.#selected }),
					total: items.length,
				},
			},
		]);
	}

	#update(): void {
		const filtered = this.#query === "" ? this.#items : fuzzyFilter(this.#items, this.#query, (item) => `${item.label} ${item.value}`);
		this.#order = filtered.map((item) => item.value);
		if (this.#selected === undefined || !this.#order.includes(this.#selected)) this.#selected = this.#order[0];
		this.#app.op(["set", this.id, { query: this.#query, cursor: this.#query.length, order: this.#order, selected: this.#selected ?? null }]);
	}

	key(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.close("");
		if (matchesKey(data, "enter")) return this.close(this.#selected ?? "");
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const index = this.#selected === undefined ? -1 : this.#order.indexOf(this.#selected);
			const next = matchesKey(data, "up") ? Math.max(0, index - 1) : Math.min(this.#order.length - 1, index + 1);
			this.#selected = this.#order[next];
			this.#app.op(["set", this.id, { selected: this.#selected ?? null }]);
			return;
		}
		if (matchesKey(data, "backspace")) this.#query = this.#query.slice(0, -1);
		else if (/^[^\x00-\x1f\x7f]+$/.test(data)) this.#query += data;
		else return;
		this.#update();
	}

	event(body: Record<string, unknown>): void {
		if (body.ev === "select" && typeof body.item === "string") {
			this.#selected = body.item;
			this.#app.op(["set", this.id, { selected: this.#selected }]);
		} else if (body.ev === "activate" && typeof body.item === "string") this.close(body.item);
		else if (body.ev === "action") this.close("");
	}

	close(value: string): void {
		this.#app.op(["del", this.id]);
		this.#app.closeModal();
		this.#resolve(value);
	}
}

/** A one-line question in a modal overlay; a secret one shows dots. */
class QuestionModal {
	readonly #app: SaavyTsp;
	readonly id: string;
	readonly #secret: boolean;
	readonly #resolve: (value: string) => void;
	#value = "";

	constructor(app: SaavyTsp, id: string, message: string, secret: boolean, resolve: (value: string) => void) {
		this.#app = app;
		this.id = id;
		this.#secret = secret;
		this.#resolve = resolve;
		app.op(
			[
				"add",
				id,
				"layer",
				null,
				{
					id,
					k: "overlay",
					p: { anchor: "center", size: "sm", modal: true, head: [{ t: message }] },
					c: [{ id: `${id}.i`, k: "input", p: { text: "", cursor: 0, placeholder: secret ? "paste or type, Enter to submit" : "" } }],
				},
			],
			["focus", `${id}.i`],
		);
	}

	key(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.close("");
		if (matchesKey(data, "enter")) return this.close(this.#value.trim());
		if (matchesKey(data, "backspace")) this.#value = this.#value.slice(0, -1);
		else if (/^[^\x00-\x1f\x7f]+$/.test(data)) this.#value += data;
		else return;
		this.#show();
	}

	paste(text: string): void {
		this.#value += text.replace(/[\x00-\x1f\x7f]/g, "");
		this.#show();
	}

	#show(): void {
		const shown = this.#secret ? "•".repeat(this.#value.length) : this.#value;
		this.#app.op(["text", `${this.id}.i`, "replace", shown], ["set", `${this.id}.i`, { cursor: shown.length }]);
	}

	event(): void {}

	close(value: string): void {
		this.#app.op(["del", this.id]);
		this.#app.closeModal();
		this.#resolve(value);
	}
}

export class SaavyTsp {
	readonly #saavy: Saavy;
	readonly #surface: Surface;
	readonly #editor: EditorModel;
	readonly #cwd: string;
	readonly #historyPath: string;
	readonly #stops: (() => void)[] = [];
	readonly #tools = new Map<string, ToolCard>();
	readonly #agentRows = new Map<string, number>();
	readonly #segments = new Map<string, string>();
	readonly #mainNodes: string[] = [];
	/** Agent UIs on screen, by handle, and which handle each wire-id prefix belongs to. */
	readonly #uis = new Map<string, { card: string; root: string; wire: Map<string, string>; agent: Map<string, string>; panel?: boolean }>();
	/** Panel panes by handle: their socket once connected, what to send when they connect, whether one is opening. */
	readonly #panels = new Map<string, Socket>();
	readonly #panelPending = new Map<string, object[]>();
	readonly #panelOpening = new Set<string>();
	#panelServer: Server | undefined;
	/** True while history is drawn at start: panels are not reopened from history. */
	#replaying = true;
	readonly #uiPrefixes = new Map<string, string>();
	#lastUiEvent = "";
	/** Agent rows inside spawn cards, by subagent id. */
	readonly #spawnRows = new Map<string, { row: string; status: string; started?: number }>();
	#blocks = new Map<number, TextBlock>();
	/** The omp.assistant column of the answer being written. */
	#answer: string | undefined;
	#streamingCalls = new Set<string>();
	#lastEntry = -1;
	#counter = 0;
	#agent: AgentState = {};
	#usage = totalUsage(undefined);
	#modal: PickerModal | QuestionModal | MemoryExplorer | undefined;
	#working = "";
	#expanded = false;
	#bashRunning = false;
	#exit: () => void = () => {};
	readonly exited: Promise<void>;

	constructor(saavy: Saavy, cwd: string, shake: Handshake) {
		this.#saavy = saavy;
		this.#cwd = cwd;
		this.#historyPath = join(saavy.home, "history");
		this.exited = new Promise((resolve) => {
			this.#exit = resolve;
		});
		this.#surface = new Surface(shake.hello!, {
			event: (body) => this.#event(body),
			key: (sequence) => this.#key(sequence),
			paste: (text) => (this.#modal instanceof QuestionModal ? this.#modal.paste(text) : this.#editor.insert(text)),
		});
		this.#editor = new EditorModel("ed", {
			submit: (text) => this.#submit(text),
			ops: (ops) => this.op(...ops),
		});
		this.#editor.setProvider(
			new CombinedAutocompleteProvider(
				commands.map((command) => ({
					name: command.name,
					description: command.help,
					...(command.complete === undefined
						? {}
						: {
								getArgumentCompletions: (prefix: string) =>
									command.complete!(saavy, prefix).map((value) => ({ value, label: value })),
							}),
				})),
				cwd,
			),
		);
		if (existsSync(this.#historyPath)) {
			for (const line of readFileSync(this.#historyPath, "utf8").split("\n").slice(-500)) {
				if (line === "") continue;
				let text = line;
				try {
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed === "string") text = parsed;
				} catch {}
				this.#editor.addToHistory(text);
			}
		}
		if (shake.kitty) {
			process.stdout.write("\x1b[>1u");
			setKittyProtocolActive(true);
		}
	}

	op(...ops: Op[]): void {
		// Remember main's top-level nodes, so a fresh start can remove them.
		for (const op of ops) if (op[0] === "add" && op[2] === "main") this.#mainNodes.push(op[1] as string);
		this.#surface.op(...ops);
	}

	/** A fresh screen: main's nodes go, memory stays. */
	#clear(): void {
		const nodes = this.#mainNodes.splice(0);
		this.op(...nodes.map((id): Op => ["del", id]));
		this.#tools.clear();
		this.#blocks = new Map();
		this.#answer = undefined;
		this.#streamingCalls = new Set();
	}

	/**
	 * A fresh node id. Generated ids start with "_", which no fixed id does: a bare prefix plus counter once made "ag"
	 * (answer 16), the dock's subagent column, and Tern attached that answer to the dock.
	 */
	#id(prefix: string): string {
		return generatedId(prefix, this.#counter++);
	}

	closeModal(): void {
		this.#modal = undefined;
		this.op(["focus", this.#editor.id]);
	}

	async start(): Promise<void> {
		const saavy = this.#saavy;
		const seg = (id: string, side?: "right") => ({ id, k: "seg", p: { text: "", ...(side ? { side } : {}) } });
		this.#surface.open({
			main: { id: "main", k: "col", c: [] },
			dock: {
				id: "dock",
				k: "col",
				c: [
					{ id: "ag", k: "col", c: [] },
					{
						id: "wk",
						k: "row",
						p: { role: "omp.working", hidden: true, gap: "sm", align: "center" },
						c: [
							{ id: "wks", k: "spinner", p: { style: "orbit", label: [{ t: "Working" }] } },
							{ id: "wke", k: "elapsed", p: { age: 0 } },
						],
					},
					{ id: "toast", k: "toast", p: { text: "", hidden: true } },
					{
						id: "cmp",
						k: "col",
						p: { role: "omp.editor" },
						c: [
							{ id: "cmp.line", k: "row", p: { role: "omp.composer.line", align: "start", gap: "sm" }, c: [this.#editor.node("Ask anything")] },
							{
								id: "cmp.bar",
								k: "row",
								p: { role: "omp.composer.bar", gap: "sm", align: "center" },
								c: [
									{
										id: "cm",
										k: "row",
										p: { role: "omp.composer.model", gap: "xs", align: "center", title: "Switch model  ctrl+l", actions: { click: "status.model" } },
										c: [
											{ id: "cm.i", k: "icon", p: { name: "model" } },
											{ id: "cm.n", k: "text", p: { text: "", wrap: "none" } },
											{ id: "cm.c", k: "icon", p: { name: "chev" } },
										],
									},
									{
										id: "ce",
										k: "row",
										p: { role: "omp.composer.effort", gap: "xs", align: "center", title: "Thinking effort  shift+tab", actions: { click: "thinking.cycle" } },
										c: [
											{ id: "ce.g", k: "effort", p: { level: "off" } },
											{ id: "ce.t", k: "text", p: { text: "off", wrap: "none" } },
										],
									},
									{
										id: "cmem",
										k: "row",
										p: { role: "saavy.memory", gap: "xs", align: "center", title: "Memory: how full the view is  click to explore", actions: { click: "explore" } },
										c: [
											// A full view is normal (older lines fold into summaries), so no warning colors.
											{ id: "cmem.m", k: "meter", p: { value: 0, style: "ring", size: "sm", tone: "accent" } },
											{ id: "cmem.t", k: "text", p: { text: "", wrap: "none" } },
											{ id: "cmem.s", k: "spinner", p: { style: "dots", hidden: true, title: "summarizing" } },
										],
									},
									{ id: "cgap", k: "row", p: { grow: 1 }, c: [] },
									{ id: "cu", k: "text", p: { text: "", wrap: "none", tone: "muted" } },
									{ id: "csend", k: "kbd", p: { role: "omp.composer.send", keys: ["enter"], title: "Send  enter", actions: { click: "submit" } } },
									{ id: "cstop", k: "text", p: { role: "omp.composer.stop", text: "Stop", tone: "error", hidden: true, title: "Stop  esc", actions: { click: "interrupt" } } },
								],
							},
						],
					},
					{ id: "st", k: "status", c: [seg("scwd"), seg("smem", "right")] },
				],
			},
			layer: { id: "layer", k: "col", c: [this.#editor.popupNode()] },
		});
		this.op(["focus", this.#editor.id]);
		const memory = saavy.memory;
		for (const entry of await saavy.recentEntries(60)) this.#addEntry(entry);
		const glance = await memory.glance();
		this.#replaying = false;
		// The splash closes the history: the greeting sits right above where the new conversation starts.
		const model = (await saavy.agent()).model;
		const splash = this.#id("s");
		this.op(["add", splash, "main", null, splashNode(splash, glance, model === undefined ? "" : `${model.provider}/${model.modelId}`)], ["settle", splash]);
		this.#stops.push(saavy.onEntry((entry) => this.#addEntry(entry)));
		const view = await saavy.root.viewState(context);
		this.#stops.push(view.subscribe((value) => this.#applyView(value)), () => view.dispose());
		this.#applyView(view.value);
		this.#stops.push(
			saavy.subscribe((event) => {
				if (event.type === "notice") this.#notice(event.level, event.message);
				else if (event.type === "connection") this.#notice(event.connected ? "info" : "warning", event.connected ? "reconnected to the brain" : "lost the brain; reconnecting…");
				else this.#syncWorking();
			}),
			memory.subscribe(() => this.#syncStatus()),
		);
		const timer = setInterval(() => {
			void this.#syncAgents();
			this.#syncStatus();
		}, 1500);
		timer.unref();
		this.#stops.push(() => clearInterval(timer));
		await this.#syncAgents();
		this.#syncWorking();
		this.#syncStatus();
		saavy.approver = async (question) =>
			(await this.#choose(question, [
				{ value: "no", label: "No, keep running as is" },
				{ value: "yes", label: "Yes, restart into the new code" },
			])) === "yes";
		this.#stops.push(() => {
			saavy.approver = undefined;
		});
	}

	async stop(): Promise<void> {
		for (const stop of this.#stops) stop();
		for (const socket of this.#panels.values()) socket.end(`${JSON.stringify({ type: "close" })}\n`);
		this.#panelServer?.close();
		if (this.#panelServer !== undefined) rmSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `saavy-panel-${process.pid}.sock`), { force: true });
		await this.#surface.close();
	}

	// ─── Input ───

	#key(data: string): void {
		if (process.env.SAAVY_TSP_KEYLOG) appendFileSync(process.env.SAAVY_TSP_KEYLOG, `${JSON.stringify(data)}\n`);
		if (this.#modal !== undefined) return this.#modal.key(data);
		if (matchesKey(data, "ctrl+c")) {
			if (this.#editor.text !== "") this.#editor.clear();
			else if (this.#saavy.phase !== "idle") this.#interrupt();
			else this.#exit();
			return;
		}
		if (matchesKey(data, "ctrl+d") && this.#editor.text === "") return this.#exit();
		if (matchesKey(data, "escape")) {
			if (!this.#editor.handleKey(data)) this.#interrupt();
			return;
		}
		if (matchesKey(data, "shift+tab")) return void this.#cycleThinking();
		if (matchesKey(data, "ctrl+l")) return void this.pickModel();
		if (matchesKey(data, "ctrl+g")) return void this.#external();
		if (matchesKey(data, "ctrl+o")) {
			this.#expanded = !this.#expanded;
			for (const card of this.#tools.values()) if (card.done) this.op(["set", card.id, { collapsed: !this.#expanded }]);
			return;
		}
		this.#editor.handleKey(data);
	}

	#event(body: Record<string, unknown>): void {
		if (typeof body.id === "string" && body.id.startsWith("_g") && (body.ev === "action" || body.ev === "activate")) {
			return this.#uiEvent(body);
		}
		if (this.#modal !== undefined && (body.ev === "select" || body.ev === "activate" || body.ev === "action")) {
			return this.#modal.event(body);
		}
		if (body.ev === "error") {
			// Tern rejected an op or a frame: a saavy bug worth seeing at once.
			const where = typeof body.s === "number" ? ` (frame ${body.s}${typeof body.op === "number" ? `, op ${body.op}` : ""})` : "";
			return this.#notice("warning", `Tern: ${String(body.msg)}${where}`);
		}
		if (body.ev === "edit" && body.id === this.#editor.id) {
			this.#editor.applyEdit(body as unknown as { from: number; to: number; text: string; cursor: number; len: number });
		} else if (body.ev === "action") {
			if (body.act === "status.model") void this.pickModel();
			else if (body.act === "thinking.cycle") void this.#cycleThinking();
			else if (body.act === "interrupt") this.#interrupt();
			else if (body.act === "submit") this.#submit(this.#editor.text);
			else if (body.act === "explore") this.#explore();
			else if (body.act === "browse") void findCommand("browse")?.run(this.#ui, "");
		} else if (body.ev === "focus" && typeof body.id === "string") {
			this.op(["focus", body.id]);
		} else if ((body.ev === "select" || body.ev === "activate") && typeof body.item === "string") {
			this.#editor.pick(body.item);
		}
	}

	#submit(raw: string): void {
		const text = raw.trim();
		if (text === "") return;
		this.#editor.addToHistory(text);
		try {
			appendFileSync(this.#historyPath, `${JSON.stringify(text)}\n`, { mode: 0o600 });
		} catch {}
		this.#editor.clear();
		if (text.startsWith("!")) return void this.#runBash(text);
		const command = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (command !== null && !text.startsWith("//")) {
			const found = findCommand(command[1]!);
			if (found === undefined) return this.#notice("warning", `Unknown command /${command[1]} (/help)`);
			found
				.run(this.#ui, (command[2] ?? "").trim())
				.catch((error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)))
				.finally(() => this.#syncStatus());
			return;
		}
		this.#saavy.send(text.startsWith("//") ? text.slice(1) : text).catch((error: unknown) => this.#notice("error", String(error)));
	}

	/** Apply an update to an agent UI on screen (inline or in its panel). */
	#applyUi(handle: string, update: UiUpdate): void {
		const ui = this.#uis.get(handle);
		if (ui === undefined) return;
		if (update.ui !== undefined) {
			const prefix = this.#id("g");
			const drawn = toWire(update.ui, prefix);
			if (ui.panel) this.#panelShow(handle, handle, drawn.node, "right");
			else this.op(["del", ui.root], ["add", drawn.node.id as string, ui.card, null, drawn.node]);
			this.#uis.set(handle, { card: ui.card, root: drawn.node.id as string, ...drawn, panel: ui.panel });
			this.#uiPrefixes.set(prefix, handle);
		}
		const current = this.#uis.get(handle)!;
		const ops: Op[] = [];
		for (const entry of update.set ?? []) {
			const id = current.wire.get(entry.id);
			if (id !== undefined) ops.push(["set", id, entry.props]);
		}
		for (const entry of update.append ?? []) {
			const id = current.wire.get(entry.id);
			if (id !== undefined) ops.push(["text", id, "append", entry.text]);
		}
		if (current.panel) this.#panelSend(handle, { type: "ops", ops });
		else if (ops.length > 0) this.op(...ops);
	}

	/** The socket panels connect back to; started on first use. */
	#panelSocket(): string {
		// In the runtime directory: a Unix socket path must stay under ~107 characters, which a deep home can pass.
		const path = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `saavy-panel-${process.pid}.sock`);
		if (this.#panelServer !== undefined) return path;
		rmSync(path, { force: true });
		this.#panelServer = createServer((socket) => {
			let handle: string | undefined;
			const lines = createInterface({ input: socket });
			lines.on("error", () => {});
			lines.on("line", (line) => {
				let message: { type?: string; handle?: string; body?: Record<string, unknown> };
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					return;
				}
				if (message.type === "hello" && typeof message.handle === "string") {
					handle = message.handle;
					this.#panels.set(handle, socket);
					this.#panelOpening.delete(handle);
					for (const queued of this.#panelPending.get(handle) ?? []) socket.write(`${JSON.stringify(queued)}\n`);
					this.#panelPending.delete(handle);
				} else if (message.type === "event" && message.body !== undefined) this.#uiEvent(message.body);
			});
			socket.on("close", () => {
				if (handle !== undefined && this.#panels.get(handle) === socket) this.#panels.delete(handle);
			});
			socket.on("error", () => {});
		});
		this.#panelServer.on("error", (error) => this.#notice("warning", `Panels are unavailable: ${error.message}`));
		this.#panelServer.listen(path);
		this.#panelServer.unref();
		return path;
	}

	/** Send to a panel, queueing until it connects. */
	#panelSend(handle: string, message: object): void {
		const socket = this.#panels.get(handle);
		if (socket !== undefined) socket.write(`${JSON.stringify(message)}\n`);
		else this.#panelPending.set(handle, [...(this.#panelPending.get(handle) ?? []), message]);
	}

	/** Show a UI in its panel, opening the pane (a Tern split beside saavy's) when there is none. */
	#panelShow(handle: string, title: string, node: Record<string, unknown>, direction: "right" | "down"): void {
		const socket = this.#panelSocket();
		// A fresh show replaces whatever was queued for a panel still opening.
		if (!this.#panels.has(handle)) this.#panelPending.set(handle, []);
		this.#panelSend(handle, { type: "show", node, title });
		if (this.#panels.has(handle) || this.#panelOpening.has(handle)) return;
		this.#panelOpening.add(handle);
		const bin = PANEL_BIN;
		execFile("tern", ["split", String(process.env.TERN_PANE), direction, "--", bin, "--socket", socket, "--handle", handle], { timeout: 15_000 }, (error) => {
			if (error !== null) {
				this.#panelOpening.delete(handle);
				this.#notice("warning", `Could not open a panel for ${handle}: ${error.message}`);
			}
		});
	}

	/** A click on agent UI becomes a message to the agent: "[ui <handle>] <action> <node id> {form values}". */
	#uiEvent(body: Record<string, unknown>): void {
		const id = body.id as string;
		const handle = this.#uiPrefixes.get(id.split(".")[0]!);
		if (handle === undefined) return;
		const ui = this.#uis.get(handle);
		const node = ui?.agent.get(id) ?? id;
		const act = body.ev === "activate" ? "select" : String(body.act ?? "click");
		// A Refresh button on a watched UI runs its watcher, no agent turn needed.
		if (act === "refresh" && this.#saavy.refresh(handle)) return;
		const item = typeof body.item === "string" ? ` ${ui?.agent.get(body.item) ?? body.item}` : "";
		const value = body.value === undefined ? "" : `=${String(body.value)}`;
		const values = body.values !== undefined && Object.keys(body.values as object).length > 0 ? ` ${JSON.stringify(body.values)}` : "";
		const text = `[ui ${handle}] ${act}${value} on ${node}${item}${values}`;
		// A double click or a repeated event is one message.
		if (text === this.#lastUiEvent) return;
		this.#lastUiEvent = text;
		setTimeout(() => {
			if (this.#lastUiEvent === text) this.#lastUiEvent = "";
		}, 800).unref();
		this.#saavy.send(text).catch((error: unknown) => this.#notice("error", String(error)));
	}

	#interrupt(): void {
		if (this.#saavy.phase !== "idle") {
			this.#notice("info", "aborting");
			void this.#saavy.abort();
		}
	}

	async #cycleThinking(): Promise<void> {
		const ref = this.#agent.model;
		const model = ref === undefined ? undefined : this.#saavy.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return;
		const levels: ModelThinkingLevel[] = ["off", ...getSupportedThinkingLevels(model).filter((level) => level !== "off")];
		await this.#saavy.setThinking(levels[(levels.indexOf(this.#agent.thinkingLevel ?? "off") + 1) % levels.length]!);
	}

	/** `!cmd` runs in the agent's directory and goes into memory; `!!cmd` stays out of it. */
	async #runBash(text: string): Promise<void> {
		const quiet = text.startsWith("!!");
		const command = text.slice(quiet ? 2 : 1).trim();
		if (command === "" || this.#bashRunning) return;
		this.#bashRunning = true;
		const id = this.#id("b");
		const started = Date.now();
		this.op([
			"add",
			id,
			"main",
			null,
			{
				id,
				k: "tool",
				p: { name: "bash", title: quiet ? "You ran (not kept)" : "You ran", target: command, targetKind: "command", status: "running", age: 0, collapsible: true, preview: { tail: 12 } },
				c: [{ id: `${id}.o`, k: "ansi", p: { text: "", follow: true } }],
			},
		]);
		const cwd = this.#agent.cwd ?? this.#cwd;
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const take = (chunk: Buffer) => {
			const part = chunk.toString("utf8");
			output += part;
			this.op(["text", `${id}.o`, "append", part]);
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
		this.#bashRunning = false;
		this.op(["set", id, { status: code === 0 ? "done" : "error", exit: code ?? 130, took: Date.now() - started, age: null }], ["settle", id]);
		if (!quiet) {
			await this.#saavy.note(`I ran \`${command}\` in ${cwd} (exit ${code ?? "killed"}):\n\`\`\`\n${cap(output.trimEnd())}\n\`\`\``);
		}
	}

	async #edit(initial: string): Promise<string | undefined> {
		const dir = mkdtempSync(join(tmpdir(), "saavy-"));
		const file = join(dir, "message.md");
		writeFileSync(file, initial);
		const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
		// Hand the pane to the editor, then take it back.
		this.#surface.now(["suspend"]);
		process.stdin.setRawMode(false);
		process.stdin.pause();
		spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
		process.stdin.setRawMode(true);
		process.stdin.resume();
		this.#surface.now(["resume"], ["focus", this.#editor.id]);
		const text = readFileSync(file, "utf8").trim();
		rmSync(dir, { recursive: true, force: true });
		return text === "" ? undefined : text;
	}

	async #external(): Promise<void> {
		const text = await this.#edit(this.#editor.text);
		if (text !== undefined) {
			this.#editor.clear();
			this.#editor.insert(text);
		}
	}

	#explore(): void {
		if (this.#modal !== undefined) return;
		MemoryExplorer.open(this.#id("e"), this.#saavy.memory, (...ops) => this.op(...ops), () => this.closeModal()).then(
			(explorer) => {
				this.#modal = explorer;
			},
			(error: unknown) => this.#notice("error", `memory: ${error instanceof Error ? error.message : String(error)}`),
		);
	}

	#choose(title: string, items: { value: string; label: string; description?: string }[]): Promise<string> {
		return new Promise((resolve) => {
			this.#modal = new PickerModal(this, this.#id("p"), title, items, resolve);
		});
	}

	async pickModel(): Promise<void> {
		const current = this.#agent.model;
		const isCurrent = (provider: string, id: string) => provider === current?.provider && id === current.modelId;
		const items = [...this.#saavy.models.getAvailableSnapshot()]
			.sort((a, b) => Number(isCurrent(b.provider, b.id)) - Number(isCurrent(a.provider, a.id)))
			.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.id, description: model.provider }));
		const value = await this.#choose("Model", items);
		if (value === "") return;
		const slash = value.indexOf("/");
		const thinking = await this.#saavy.setModel({ provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
		this.#notice("info", `main model: ${value} (thinking ${thinking})`);
	}

	get #ui(): Ui {
		return {
			saavy: this.#saavy,
			print: (message) => this.#addText(message),
			ask: (message, secret) =>
				new Promise((resolve) => {
					this.#modal = new QuestionModal(this, this.#id("q"), message, secret, resolve);
				}),
			choose: (message, options) => this.#choose(message, options.map((option) => ({ value: option.id, label: option.label }))),
			edit: (initial) => this.#edit(initial ?? ""),
			send: (text) => void this.#saavy.send(text).catch((error: unknown) => this.#notice("error", String(error))),
			quit: () => this.#exit(),
			clear: () => this.#clear(),
			explore: () => this.#explore(),
			showDoc: (title, markdown) => {
				const id = this.#id("d");
				this.op(
					["add", id, "main", null, { id, k: "card", p: { head: title, collapsible: true, collapsed: false, tone: "accent" }, c: [{ id: `${id}.m`, k: "md", p: { text: markdown } }] }],
					["settle", id],
				);
			},
			pickModel: () => this.pickModel(),
		};
	}

	// ─── Transcript ───

	#addText(text: string, tone?: "muted"): void {
		const id = this.#id("n");
		const node = text.includes("\n")
			? { id, k: "code", p: { lang: "text", text } }
			: { id, k: "text", p: { text, ...(tone === undefined ? {} : { tone }) } };
		this.op(["add", id, "main", null, node], ["settle", id]);
	}

	/** Draw one entry; a failure to draw it is a warning, never the end of the session. */
	#addEntry(entry: EntryRecord): void {
		try {
			this.#drawEntry(entry);
		} catch (error) {
			this.#notice("warning", `Could not draw entry ${String(entry.id)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#drawEntry(entry: EntryRecord): void {
		this.#lastEntry = Math.max(this.#lastEntry, Number(entry.id));
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			const text = userText(message.content);
			if (text.startsWith("[ui ")) {
				const id = this.#id("n");
				this.op(["add", id, "main", null, { id, k: "text", p: { spans: [{ t: `↳ ${text.slice(4).replace(/^([^\]]+)\]/, "$1 ·")}`, s: "muted" }] } }], ["settle", id]);
				return;
			}
			if (text === CLEARED || text.startsWith("[saavy restarted into its changed source")) {
				const id = this.#id("r");
				const label = text === CLEARED ? `fresh start · ${this.#saavy.memory.stats.messages} messages in memory` : text.slice(1, -1);
				this.op(["add", id, "main", null, { id, k: "rule", p: { label } }], ["settle", id]);
				return;
			}
			const id = this.#id("u");
			const report = /^\[a\d+\] /.test(text);
			const node = report
				? { id, k: "card", p: { tone: "accent", head: "subagents" }, c: [{ id: `${id}.m`, k: "md", p: { text } }] }
				: { id, k: "card", p: { tone: "user", role: "omp.user" }, c: [{ id: `${id}.m`, k: "md", p: { text } }] };
			this.op(["add", id, "main", null, node], ["settle", id]);
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			this.#syncMessage(message, false);
			const ran = message.stopReason === "toolUse";
			for (const block of this.#blocks.values()) {
				this.op(["set", block.md, { stream: false }]);
				if (block.thinking) this.op(["set", block.id, { collapsed: true, role: "omp.thinking" }]);
			}
			if (this.#answer !== undefined) this.op(["settle", this.#answer]);
			this.#answer = undefined;
			for (const content of message.content) {
				if (content.type !== "toolCall" || ran) continue;
				const card = this.#tools.get(content.id);
				if (card !== undefined) {
					card.done = true;
					this.op(["set", card.id, { status: "cancelled", note: "not run: the answer was interrupted" }], ["settle", card.id]);
				}
			}
			this.#blocks = new Map();
			this.#streamingCalls = new Set();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			this.#toolResult(message as ToolResultMessage);
		} else if (entry.kind === "pi.compaction") {
			const id = this.#id("r");
			this.op(["add", id, "main", null, { id, k: "rule", p: { label: "the run was compacted to fit the context" } }], ["settle", id]);
		}
	}

	/** Bring the nodes of an answer up to `message`: text and thinking stream by appends, tool calls get cards. */
	#syncMessage(message: AssistantMessage, streaming: boolean): void {
		message.content.forEach((content, index) => {
			if (content.type === "toolCall") {
				this.#tool(content.id, content.name, content.arguments);
				this.#streamingCalls.add(content.id);
				return;
			}
			const text = content.type === "text" ? content.text : content.type === "thinking" ? content.thinking : undefined;
			if (text === undefined || (text.trim() === "" && !this.#blocks.has(index))) return;
			const block = this.#blocks.get(index);
			if (block === undefined) {
				const thinking = content.type === "thinking";
				const id = this.#id(thinking ? "k" : "t");
				const md = thinking ? `${id}.m` : id;
				const node = thinking
					? { id, k: "section", p: { head: "Thinking", collapsible: true, collapsed: !streaming, role: streaming ? "omp.thinking.live" : "omp.thinking" }, c: [{ id: md, k: "md", p: { text, stream: streaming } }] }
					: { id, k: "md", p: { text, stream: streaming } };
				// One answer is one omp.assistant column; its tool cards follow it in main.
				if (this.#answer === undefined) {
					this.#answer = this.#id("a");
					this.op(["add", this.#answer, "main", null, { id: this.#answer, k: "col", p: { role: "omp.assistant" }, c: [] }]);
				}
				this.op(["add", id, this.#answer, null, node]);
				this.#blocks.set(index, { id, md, thinking, sent: text });
				return;
			}
			if (text === block.sent) return;
			if (text.startsWith(block.sent)) this.op(["text", block.md, "append", text.slice(block.sent.length)]);
			else this.op(["text", block.md, "replace", text]);
			block.sent = text;
		});
	}

	#tool(callId: string, name: string, args: unknown): ToolCard {
		const existing = this.#tools.get(callId);
		const given = (args ?? {}) as Record<string, unknown>;
		const head = toolHead(name, given);
		if (existing !== undefined) {
			if (Object.keys(given).length > 0) existing.args = given;
			if (!existing.done && head.target !== undefined) this.op(["set", existing.id, { target: head.target }]);
			return existing;
		}
		const id = this.#id("x");
		const body = `${id}.o`;
		const inline = INLINE_TOOLS.has(name);
		const bodyNode = name === "bash" ? { id: body, k: "ansi", p: { text: "", follow: true } } : { id: body, k: "code", p: { lang: "text", text: "" } };
		const props = inline
			? { ...head, role: `omp.tool.${name}`, key: callId, status: "pending", frame: "inline" }
			: { ...head, role: `omp.tool.${name}`, key: callId, status: "pending", collapsible: true, collapsed: false, preview: name === "bash" ? { tail: 10 } : { lines: 10 } };
		this.op(["add", id, "main", null, { id, k: "tool", p: props, c: inline ? [] : [bodyNode] }]);
		const card: ToolCard = { id, body, name, args: given, sent: "", done: false };
		this.#tools.set(callId, card);
		return card;
	}

	#toolResult(result: ToolResultMessage): void {
		const card = this.#tool(result.toolCallId, result.toolName, {});
		const text = cap(
			result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n")
				.trimEnd(),
		);
		const patch = (result.details as { patch?: unknown } | undefined)?.patch;
		const took = card.started === undefined ? undefined : Date.now() - card.started;
		const finish = (extra: Record<string, unknown> = {}, collapse = card.name === "show" ? false : !this.#expanded) => {
			card.sent = text;
			card.done = true;
			this.op(
				["set", card.id, { status: result.isError ? "error" : "done", age: null, ...(took === undefined ? {} : { took }), ...(card.name === "spawn" || INLINE_TOOLS.has(card.name) ? {} : { collapsed: collapse }), ...extra }],
				["settle", card.id],
			);
		};
		if (!result.isError && INLINE_TOOLS.has(card.name)) return finish({ note: text.replace(/\s+/g, " ") });
		if (!result.isError && card.name === "show") {
			const handle = String(card.args.handle ?? "");
			const spec = card.args.ui as UiNode | undefined;
			// The call (with the spec) can be older than the history drawn at start, while its result is not.
			if (spec === undefined || checkUi(spec) !== undefined) {
				this.op(["del", card.body]);
				return finish({ frame: "inline", note: `${handle || "a UI"}: its call is older than the history shown`, collapsible: false });
			}
			const existing = this.#uis.get(handle);
			const prefix = this.#id("g");
			const drawn = toWire(spec, prefix);
			const placement = String(card.args.placement ?? "inline");
			// A panel opens a pane beside the chat (only live, in a Tern pane: history redraws inline, folded).
			if (placement !== "inline" && process.env.TERN_PANE !== undefined && !this.#replaying) {
				this.op(["del", card.body]);
				this.#uis.set(handle, { card: card.id, root: drawn.node.id as string, ...drawn, panel: true });
				this.#uiPrefixes.set(prefix, handle);
				this.#panelShow(handle, String(card.args.title ?? handle), drawn.node, placement === "panel-down" ? "down" : "right");
				return finish({ frame: "inline", note: `${existing?.panel ? "redrew" : "opened"} ${handle} in a panel →`, collapsible: false });
			}
			if (existing === undefined || existing.panel) {
				// The UI is this card's body (a panel UI replayed from history comes folded).
				this.op(["del", card.body], ["add", drawn.node.id as string, card.id, null, drawn.node]);
				this.#uis.set(handle, { card: card.id, root: drawn.node.id as string, ...drawn });
				this.#uiPrefixes.set(prefix, handle);
				return finish(placement === "inline" ? {} : { note: "shown in a panel" }, placement !== "inline");
			}
			// Same handle: redraw in the original card; this call's card just says so.
			this.op(["del", existing.root], ["add", drawn.node.id as string, existing.card, null, drawn.node], ["del", card.body]);
			this.#uis.set(handle, { card: existing.card, root: drawn.node.id as string, ...drawn });
			this.#uiPrefixes.set(prefix, handle);
			return finish({ frame: "inline", note: `redrew ${handle} above`, collapsible: false });
		}
		if (!result.isError && card.name === "update_ui") {
			const handle = String(card.args.handle ?? "");
			const ui = this.#uis.get(handle);
			this.op(["del", card.body]);
			if (ui === undefined) return finish({ frame: "inline", note: `no UI named ${handle} on screen`, collapsible: false });
			this.#applyUi(handle, card.args as unknown as UiUpdate);
			return finish({ frame: "inline", note: `updated ${handle}`, collapsible: false });
		}
		if (!result.isError && (card.name === "zoom" || card.name === "search") && Number(card.args.n ?? 2) !== 1) {
			const items = lineItems(text);
			if (items.length > 0) {
				this.op(["del", card.body], ["add", `${card.id}.kv`, card.id, null, { id: `${card.id}.kv`, k: "kv", p: { items } }]);
				const meta = card.name === "search" ? { meta: [`${items.length} hit${items.length === 1 ? "" : "s"}`] } : {};
				return finish(meta, false);
			}
			if (card.name === "search") return finish({ note: text.replace(/\s+/g, " ") });
		}
		if (!result.isError && card.name === "spawn") {
			// One live agent row per subagent; #syncAgents keeps them current.
			const names = /Started ([^.]+)\./.exec(text)?.[1]?.split(/,\s*/) ?? [];
			const tasks = Array.isArray(card.args.tasks) ? (card.args.tasks as unknown[]) : [];
			this.op(["del", card.body]);
			names.forEach((name, n) => {
				const row = `${card.id}.ag.${name}`;
				const task = typeof tasks[n] === "string" ? (tasks[n] as string).replace(/\s+/g, " ") : "";
				this.#spawnRows.set(name, { row, status: "" });
				this.op(["add", row, card.id, null, { id: row, k: "agent", p: { name, task, status: "pending" } }]);
			});
			void this.#syncAgents();
			return finish();
		}
		if (typeof patch === "string" && patch !== "") {
			// An edit shows its diff natively.
			this.op(["del", card.body], ["add", `${card.id}.d`, card.id, null, { id: `${card.id}.d`, k: "diff", p: { text: patch } }]);
		} else if (text !== card.sent) {
			this.op(text.startsWith(card.sent) ? ["text", card.body, "append", text.slice(card.sent.length)] : ["text", card.body, "replace", text]);
		}
		finish();
	}

	#applyView(view: ConversationView): void {
		try {
			this.#drawView(view);
		} catch (error) {
			this.#notice("warning", `Could not draw the live state: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#drawView(view: ConversationView): void {
		this.#agent = (view.docs["pi.agent"] ?? {}) as AgentState;
		this.#usage = totalUsage(view.docs["pi.usage"] as UsageState | undefined);
		const live = (view.docs["pi.live"] ?? {}) as LiveState;
		const newest = view.entries.at(-1);
		if (newest === undefined || Number(newest.id) >= this.#lastEntry) {
			const message = live.generation?.message as AssistantMessage | undefined;
			if (message === undefined && this.#blocks.size > 0) {
				// A partial dropped without an entry, for example by a retry.
				if (this.#answer !== undefined) this.op(["del", this.#answer]);
				this.#answer = undefined;
				this.#blocks = new Map();
			}
			if (message !== undefined) this.#syncMessage(message, true);
			for (const slot of live.tools ?? []) {
				if (slot.status === "pending") continue;
				const card = this.#tool(slot.callId, slot.name, undefined);
				if (slot.status !== "running" || card.done) continue;
				if (card.started === undefined) {
					card.started = Date.now();
					this.op(["set", card.id, { status: "running", age: 0 }]);
				}
				if (slot.output !== undefined && slot.output !== card.sent) {
					this.op(slot.output.startsWith(card.sent) ? ["text", card.body, "append", slot.output.slice(card.sent.length)] : ["text", card.body, "replace", slot.output]);
					card.sent = slot.output;
				}
			}
			this.#syncWorking(live);
		}
		this.#syncStatus();
	}

	// ─── Dock ───

	#syncWorking(live?: LiveState): void {
		const saavy = this.#saavy;
		let text = "";
		if (saavy.phase === "settling") {
			const waiting = saavy.memory.stats.unbuilt;
			text = waiting > 0 ? `Waiting for ${waiting} summaries (esc cancels; answers anyway after 20s)` : "Starting";
		} else if (saavy.phase === "running") {
			const retry = live?.generation?.retry;
			const tool = live?.tools?.find((slot) => slot.status === "running");
			text = retry !== undefined ? `Retrying: ${retry.error}` : tool !== undefined ? `Running ${tool.name}` : "Working";
		}
		if (text === this.#working) return;
		const wasHidden = this.#working === "";
		this.#working = text;
		const busy = text !== "";
		this.op(["set", "cmp", { tone: busy ? "pending" : null }], ["set", "csend", { hidden: busy }], ["set", "cstop", { hidden: !busy }]);
		if (text === "") return this.op(["set", "wk", { hidden: true }]);
		this.op(["set", "wks", { label: [{ t: text }] }], ["set", "wk", { hidden: false }]);
		if (wasHidden) this.op(["set", "wke", { age: 0 }]);
	}

	async #syncAgents(): Promise<void> {
		const agents = await this.#saavy.subagents();
		setAgentIds(agents.map((agent) => agent.id));
		const working = new Set(agents.filter((agent) => agent.working).map((agent) => agent.id));
		for (const agent of agents) {
			const row = `ag.${agent.id}`;
			if (working.has(agent.id) && !this.#agentRows.has(agent.id)) {
				this.#agentRows.set(agent.id, Date.now());
				this.op(["add", row, "ag", null, { id: row, k: "agent", p: { name: agent.id, task: agent.task.replace(/\s+/g, " "), status: "running", stats: { age: 0 } } }]);
			} else if (!working.has(agent.id) && this.#agentRows.has(agent.id)) {
				this.#agentRows.delete(agent.id);
				this.op(["del", row]);
			}
			// The rows inside spawn cards follow each subagent: running with its tool, then done once reported.
			const spawned = this.#spawnRows.get(agent.id);
			if (spawned === undefined) continue;
			const status = agent.working ? "running" : agent.reported ? "done" : "idle";
			const key = `${status}:${agent.tool ?? ""}`;
			if (spawned.status === key) continue;
			const props: Record<string, unknown> = { status, tool: agent.tool === undefined ? null : { name: agent.tool } };
			if (status === "running" && spawned.started === undefined) {
				spawned.started = Date.now();
				props.stats = { age: 0 };
			} else if (status !== "running" && spawned.started !== undefined) {
				props.stats = { took: Date.now() - spawned.started };
				spawned.started = undefined;
			}
			spawned.status = key;
			this.op(["set", spawned.row, props]);
		}
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		this.op(["set", "toast", { text: message, tone: level === "error" ? "error" : level === "warning" ? "warning" : "info", ttl: level === "info" ? 4000 : 10000, hidden: false }]);
	}

	#segment(id: string, text: string): void {
		if (this.#segments.get(id) === text) return;
		this.#segments.set(id, text);
		this.op(["set", id, { text }]);
	}

	#syncStatus(): void {
		const { memory } = this.#saavy;
		const model = this.#agent.model;
		this.#segment("cm.n", model === undefined ? "no model" : model.modelId);
		const level = this.#agent.thinkingLevel ?? "off";
		if (this.#segments.get("ce.g") !== level) {
			this.#segments.set("ce.g", level);
			this.op(["set", "ce.g", { level }]);
		}
		this.#segment("ce.t", level);
		this.#segment("scwd", this.#agent.cwd ?? this.#cwd);
		const stats = memory.stats;
		const fill = Math.min(1, stats.viewBytes / VIEW);
		const percent = `${Math.round(fill * 100)}%`;
		if (this.#segments.get("cmem.m") !== percent) {
			this.#segments.set("cmem.m", percent);
			this.op(["set", "cmem.m", { value: fill }]);
		}
		this.#segment("cmem.t", `${stats.messages}`);
		const busy = stats.compacting > 0 || stats.unbuilt > 0 ? "busy" : "idle";
		if (this.#segments.get("cmem.s") !== busy) {
			this.#segments.set("cmem.s", busy);
			this.op(["set", "cmem.s", { hidden: busy === "idle" }]);
		}
		const unbuilt = stats.unbuilt;
		this.#segment("smem", `${stats.messages} msgs · ${stats.summaries} summaries${unbuilt > 0 ? ` · ${unbuilt} to summarize` : ""}`);
		const usage = this.#usage;
		const cached = usage.cacheRead > 0 ? ` ⟲${formatTokens(usage.cacheRead)}` : "";
		this.#segment("cu", `↑${formatTokens(usage.input)}${cached} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(3)}`);
	}
}

export async function runTsp(saavy: Saavy, shake: Handshake): Promise<void> {
	const cwd = (await saavy.agent()).cwd ?? process.cwd();
	const app = new SaavyTsp(saavy, cwd, shake);
	await app.start();
	await app.exited;
	await app.stop();
}
