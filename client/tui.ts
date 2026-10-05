// The terminal front end, on pi-tui and pi's interactive components (after pi's experimental durable TUI).
//
// Entries come from the host's commit stream, which spans the per-turn resets; streaming partials, running tools, and
// usage come from the main conversation's view state. A view state older than what is on screen is skipped for
// streaming, so a late frame never brings back a partial whose entry is already shown.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ModelThinkingLevel, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CustomEditor,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DynamicBorder,
	getMarkdownTheme,
	getSelectListTheme,
	initTheme,
	keyText,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentState, ConversationView, EntryRecord, LiveState, UsageState } from "@earendil-works/pi-durable";
import {
	Box,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	TuiAltScreen,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { cap } from "../core/log.ts";
import type { RemoteSaavy as Saavy } from "./remote.ts";
import { CLEARED, commands, findCommand, setAgentIds, type Ui } from "./commands.ts";
import { applyUpdate, checkUi, toText, type UiNode, type UiUpdate } from "../core/ui.ts";
import { createKeybindings, theme } from "./pi-internals.ts";

const context = BACKGROUND_CONTEXT;

type Renderer = ConstructorParameters<typeof ToolExecutionComponent>[4];

const userText = (content: UserMessage["content"]): string =>
	typeof content === "string"
		? content
		: content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");

const formatTokens = (n: number): string =>
	n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

function totalUsage(state: UsageState | undefined): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** One line, cut to the width. */
class Line implements Component {
	#text = "";
	setText(text: string): void {
		this.#text = text;
	}
	render(width: number): string[] {
		return [truncateToWidth(` ${this.#text}`, width)];
	}
	invalidate(): void {}
}

/** A filterable list in place of the editor (pi's ListSelector). */
class ListSelector extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #items: SelectItem[];
	readonly #onSelect: (value: string) => void;
	readonly #onCancel: () => void;
	#list: SelectList;
	#focused = false;

	constructor(title: string, items: SelectItem[], onSelect: (value: string) => void, onCancel: () => void) {
		super();
		this.#items = items;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#list = this.#build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.#input);
		this.addChild(this.#listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => keybindings.matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		const filtered =
			query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.value}`);
		this.#list = this.#build(filtered);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 12, getSelectListTheme());
		list.onSelect = (item) => this.#onSelect(item.value);
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

/** A one-line question in place of the editor; a secret one is not echoed. */
class Question extends Container implements Focusable {
	readonly #input = new Input();
	readonly #secret: boolean;
	readonly #onDone: (value: string) => void;
	#value = "";
	#focused = false;

	constructor(message: string, secret: boolean, onDone: (value: string) => void) {
		super();
		this.#secret = secret;
		this.#onDone = onDone;
		this.#input.onSubmit = (value) => onDone(value.trim());
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", message), 1, 0));
		if (!secret) this.addChild(this.#input);
		else this.addChild({ render: (width) => this.#masked(width), invalidate: () => {} });
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	#masked(width: number): string[] {
		const dots = "•".repeat(Math.min(this.#value.length, 48));
		return [truncateToWidth(` ${dots}${theme.fg("dim", this.#value.length > 0 ? ` (${this.#value.length})` : " paste or type, Enter to submit")}`, width)];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.#onDone("");
		if (!this.#secret) return this.#input.handleInput(data);
		if (matchesKey(data, Key.enter)) return this.#onDone(this.#value.trim());
		if (matchesKey(data, Key.backspace)) this.#value = this.#value.slice(0, -1);
		else {
			// Bracketed paste markers and control characters are not part of a key.
			const text = data.replace(/\x1b\[20[01]~/g, "").replace(/[\x00-\x1f\x7f]/g, "");
			this.#value += text;
		}
		this.invalidate();
	}
}

/** A subagent report, which reaches the main agent as a user message starting "[id] ". */
class ReportComponent extends Box {
	constructor(text: string) {
		super(1, 1, (line) => theme.bg("customMessageBg", line));
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[subagents]")), 0, 0));
		this.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
	}
}

export class SaavyTui {
	readonly #saavy: Saavy;
	readonly #ui: TuiAltScreen;
	readonly #chat = new Container();
	readonly #agents = new Container();
	readonly #notices = new Container();
	readonly #status = new Container();
	readonly #editorContainer = new Container();
	readonly #footerTop = new Line();
	readonly #footerBottom = new Line();
	readonly #editor: CustomEditor;
	readonly #transcript: ScrollView;
	readonly #renderers: Record<string, Renderer>;
	readonly #cwd: string;
	readonly #historyPath: string;
	/** The newest card per call ID; provider call IDs may repeat across turns. */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	readonly #cards: ToolExecutionComponent[] = [];
	readonly #bashCards: BashExecutionComponent[] = [];
	/** Call IDs whose cards the streaming answer created; its entry takes them over. */
	readonly #streamingCalls = new Set<string>();
	readonly #stops: (() => void)[] = [];
	#streaming: AssistantMessageComponent | undefined;
	/** Tool call arguments by call id (agent UI specs), and the agent UIs drawn as text. */
	readonly #callArgs = new Map<string, unknown>();
	readonly #uis = new Map<string, { box: Box; spec: UiNode; title: string }>();
	#lastEntry = -1;
	#expanded = false;
	#loader: Loader | undefined;
	#statusText = "";
	#agent: AgentState = {};
	#usage: Usage = totalUsage(undefined);
	#bash: ChildProcess | undefined;
	#exit: () => void = () => {};
	readonly exited: Promise<void>;

	constructor(saavy: Saavy, cwd: string) {
		this.#saavy = saavy;
		this.#cwd = cwd;
		this.#historyPath = join(saavy.home, "history");
		this.exited = new Promise((resolve) => {
			this.#exit = resolve;
		});
		this.#renderers = {
			bash: createBashToolDefinition(cwd),
			read: createReadToolDefinition(cwd),
			edit: createEditToolDefinition(cwd),
			write: createWriteToolDefinition(cwd),
		};
		this.#ui = new TuiAltScreen(new ProcessTerminal(), false, saavy.home);
		// pi's keybindings file, shared with pi and the local agent.
		const keybindings = createKeybindings(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
		setKeybindings(keybindings);
		this.#editor = new CustomEditor(
			this.#ui,
			{ borderColor: (text) => theme.fg("borderMuted", text), selectList: getSelectListTheme() },
			keybindings,
			{ paddingX: 1 },
		);
		this.#editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				commands.map((command) => ({
					name: command.name,
					description: command.help,
					argumentHint: command.usage.slice(command.name.length + 2),
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
		this.#editor.onSubmit = (text) => this.#submit(text);
		this.#editor.onEscape = () => this.#interrupt();
		this.#editor.onCtrlD = () => this.#exit();
		this.#editor.onAction("app.clear", () => {
			if (this.#editor.getText() !== "") this.#editor.setText("");
			else if (this.#bash !== undefined || saavy.phase !== "idle") this.#interrupt();
			else this.#exit();
		});
		this.#editor.onAction("app.model.select", () => void this.pickModel());
		this.#editor.onAction("app.thinking.cycle", () => void this.#cycleThinking());
		this.#editor.onAction("app.editor.external", () => void this.#external());
		this.#editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const card of [...this.#cards, ...this.#bashCards]) card.setExpanded(this.#expanded);
			this.#ui.requestRender();
		});
		if (existsSync(this.#historyPath)) {
			for (const line of readFileSync(this.#historyPath, "utf8").split("\n").slice(-500)) {
				if (line === "") continue;
				// One JSON string per line (multi-line prompts); older files held plain lines.
				let text = line;
				try {
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed === "string") text = parsed;
				} catch {}
				this.#editor.addToHistory(text);
			}
		}

		this.#editorContainer.addChild(this.#editor);
		const content = new Container();
		content.addChild(this.#chat);
		content.addChild(new Spacer(1));
		this.#transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		const footer = new Container();
		footer.addChild(this.#footerTop);
		footer.addChild(this.#footerBottom);
		const dock = new VStack([
			{ component: this.#agents, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#status, shrink: 0, minSize: 0 },
			{ component: this.#editorContainer, shrink: 1, minSize: 3 },
			{ component: footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [this.#chat, this.#agents, this.#notices, this.#status, this.#editorContainer, footer]) {
			this.#ui.addChild(component);
		}
		this.#ui.setLayoutRoot(
			new VStack([
				{ component: this.#transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.#ui.setFocus(this.#editor);
		this.#uiApi = this.#makeUi();
	}

	async start(): Promise<void> {
		const saavy = this.#saavy;
		this.#ui.start();
		const memory = saavy.memory;
		this.#addText(
			`saavy · ${memory.stats.messages} messages in memory · ${memory.stats.viewLines} view lines · /help for commands`,
		);
		for (const entry of await saavy.recentEntries(60)) this.#addEntry(entry);
		this.#stops.push(saavy.onEntry((entry) => this.#addEntry(entry)));
		const view = await saavy.root.viewState(context);
		this.#stops.push(view.subscribe((value) => this.#applyView(value)), () => view.dispose());
		this.#applyView(view.value);
		this.#stops.push(
			saavy.subscribe((event) => {
				if (event.type === "notice") this.#notice(event.level, event.message);
				else if (event.type === "connection") this.#notice(event.connected ? "info" : "warning", event.connected ? "reconnected to the brain" : "lost the brain; reconnecting…");
				else this.#syncStatus();
			}),
			memory.subscribe(() => this.#syncFooter()),
		);
		const timer = setInterval(() => {
			void this.#syncAgents();
			this.#syncFooter();
		}, 1500);
		timer.unref();
		this.#stops.push(() => clearInterval(timer));
		await this.#syncAgents();
		this.#syncStatus();
		this.#syncFooter();
		saavy.approver = async (question) =>
			(await this.#choose(question, [
				{ value: "no", label: "No, keep running as is" },
				{ value: "yes", label: "Yes, restart into the new code" },
			])) === "yes";
		this.#stops.push(() => {
			saavy.approver = undefined;
		});
		this.#transcript.scrollToEnd();
		this.#ui.requestRender(true);
	}

	stop(): void {
		for (const stop of this.#stops) stop();
		this.#bash?.kill();
		for (const card of this.#cards) card.updateResult({ content: [], isError: false }, false);
		this.#loader?.stop();
		this.#ui.stop();
	}

	// ─── Input ───

	#submit(raw: string): void {
		const text = raw.trim();
		if (text === "") return;
		this.#editor.addToHistory(text);
		try {
			appendFileSync(this.#historyPath, `${JSON.stringify(text)}\n`, { mode: 0o600 });
		} catch {}
		this.#editor.setText("");
		if (text.startsWith("!")) return void this.#runBash(text);
		const command = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (command !== null && !text.startsWith("//")) {
			const found = findCommand(command[1]!);
			if (found === undefined) {
				return this.#notice("warning", `Unknown command /${command[1]} (/help; start with // to send a message beginning with /)`);
			}
			found
				.run(this.#uiApi, (command[2] ?? "").trim())
				.catch((error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)))
				.finally(() => this.#syncFooter());
			return;
		}
		this.#saavy
			.send(text.startsWith("//") ? text.slice(1) : text)
			.catch((error: unknown) => this.#notice("error", String(error)));
	}

	#interrupt(): void {
		if (this.#bash !== undefined) this.#bash.kill("SIGINT");
		else if (this.#saavy.phase !== "idle") {
			this.#notice("info", "aborting");
			void this.#saavy.abort();
		}
	}

	/** `!cmd` runs in the agent's directory and goes into memory; `!!cmd` stays out of it (as in pi). */
	async #runBash(text: string): Promise<void> {
		const quiet = text.startsWith("!!");
		const command = text.slice(quiet ? 2 : 1).trim();
		if (command === "" || this.#bash !== undefined) return;
		const card = new BashExecutionComponent(command, this.#ui, quiet);
		card.setExpanded(this.#expanded);
		this.#bashCards.push(card);
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(card);
		const cwd = this.#agent.cwd ?? this.#cwd;
		const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		this.#bash = child;
		let output = "";
		const take = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output += text;
			card.appendOutput(text);
			this.#ui.requestRender();
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
		this.#bash = undefined;
		card.setComplete(code ?? undefined, code === null);
		this.#ui.requestRender();
		if (!quiet) {
			await this.#saavy.note(`I ran \`${command}\` in ${cwd} (exit ${code ?? "killed"}):\n\`\`\`\n${cap(output.trimEnd())}\n\`\`\``);
		}
	}

	async #cycleThinking(): Promise<void> {
		const ref = this.#agent.model;
		const model = ref === undefined ? undefined : this.#saavy.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return;
		const levels: ModelThinkingLevel[] = ["off", ...getSupportedThinkingLevels(model).filter((level) => level !== "off")];
		const next = levels[(levels.indexOf(this.#agent.thinkingLevel ?? "off") + 1) % levels.length]!;
		await this.#saavy.setThinking(next);
	}

	/** Edit the current draft in $EDITOR; it comes back into the editor, not sent. */
	async #external(): Promise<void> {
		const text = await this.#edit(this.#editor.getText());
		if (text !== undefined) this.#editor.setText(text);
	}

	async #edit(initial: string): Promise<string | undefined> {
		const dir = mkdtempSync(join(tmpdir(), "saavy-"));
		const file = join(dir, "message.md");
		writeFileSync(file, initial);
		const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
		this.#ui.stop();
		spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
		this.#ui.start();
		const text = readFileSync(file, "utf8").trim();
		rmSync(dir, { recursive: true, force: true });
		this.#ui.requestRender(true);
		return text === "" ? undefined : text;
	}

	#mount(component: Component): void {
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(component);
		this.#ui.requestRender();
	}

	#restoreEditor(): void {
		this.#mount(this.#editor);
	}

	#choose(title: string, items: SelectItem[]): Promise<string> {
		return new Promise((resolve) => {
			this.#mount(
				new ListSelector(
					title,
					items,
					(value) => {
						this.#restoreEditor();
						resolve(value);
					},
					() => {
						this.#restoreEditor();
						resolve("");
					},
				),
			);
		});
	}

	async pickModel(): Promise<void> {
		const current = this.#agent.model;
		const isCurrent = (provider: string, id: string) => provider === current?.provider && id === current.modelId;
		const items = [...this.#saavy.models.getAvailableSnapshot()]
			.sort((a, b) => Number(isCurrent(b.provider, b.id)) - Number(isCurrent(a.provider, a.id)))
			.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.id, description: model.provider }));
		const value = await this.#choose("Model (type to filter):", items);
		if (value === "") return;
		const slash = value.indexOf("/");
		const thinking = await this.#saavy.setModel({ provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
		this.#notice("info", `main model: ${value} (thinking ${thinking})`);
	}

	/** What commands may use: built in the constructor, once the fields exist. */
	readonly #uiApi: Ui;

	#makeUi(): Ui {
		return {
		saavy: this.#saavy,
		print: (message) => this.#addText(message, "text"),
		ask: (message, secret) =>
			new Promise((resolve) => {
				this.#mount(
					new Question(message, secret, (value) => {
						this.#restoreEditor();
						resolve(value);
					}),
				);
			}),
		choose: (message, options) => this.#choose(message, options.map((option) => ({ value: option.id, label: option.label }))),
		edit: (initial) => this.#edit(initial ?? ""),
		send: (text) => void this.#saavy.send(text).catch((error: unknown) => this.#notice("error", String(error))),
		quit: () => this.#exit(),
		clear: () => this.#clear(),
		explore: () => void findCommand("browse")?.run(this.#uiApi, ""),
		showDoc: (title, markdown) => {
			const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
			box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(title)), 0, 0));
			box.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(box);
			this.#ui.requestRender();
		},
		pickModel: () => this.pickModel(),
		};
	}

	// ─── Transcript ───

	/** A fresh screen: the transcript goes, memory stays. */
	#clear(): void {
		for (const card of this.#cards) card.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#bashCards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
		this.#streaming = undefined;
		this.#chat.clear();
		this.#ui.requestRender(true);
	}

	/** Agent UI as text (TSP draws it natively): a box per handle, redrawn on updates. */
	#drawUi(tool: string, callId: string): void {
		const args = this.#callArgs.get(callId) as { handle?: string; title?: string; ui?: UiNode } | undefined;
		const handle = String(args?.handle ?? "");
		if (args === undefined || handle === "") return;
		let ui = this.#uis.get(handle);
		const spec = tool === "show" ? args.ui : ui === undefined ? undefined : applyUpdate(ui.spec, args as UiUpdate);
		if (spec === undefined || checkUi(spec) !== undefined) return;
		if (ui === undefined) {
			ui = { box: new Box(1, 1, (line) => theme.bg("customMessageBg", line)), spec, title: args.title ?? handle };
			this.#uis.set(handle, ui);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(ui.box);
		}
		ui.spec = spec;
		if (tool === "show" && args.title !== undefined) ui.title = args.title;
		ui.box.clear();
		ui.box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(ui.title)), 0, 0));
		ui.box.addChild(new Markdown(toText(spec), 0, 0, getMarkdownTheme(), { color: (line) => theme.fg("customMessageText", line) }));
		this.#ui.requestRender();
	}

	#addText(text: string, color: "muted" | "text" | "dim" = "muted"): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg(color, text), 1, 0));
		this.#ui.requestRender();
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
			if (text === CLEARED) return this.#addText(`── fresh start · ${this.#saavy.memory.stats.messages} messages in memory ──`, "dim");
			if (text.startsWith("[saavy restarted into its changed source")) return this.#addText(`── ${text.slice(1, -1)} ──`, "dim");
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(/^\[a\d+\] /.test(text) ? new ReportComponent(text) : new UserMessageComponent(text));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				if (!ran && !streamed) continue;
				this.#callArgs.set(content.id, content.arguments);
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) card.updateResult({ content: [{ type: "text", text: "Not run: the answer was interrupted." }], isError: true }, false);
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
			if (!result.isError && (result.toolName === "show" || result.toolName === "update_ui")) this.#drawUi(result.toolName, result.toolCallId);
		} else if (entry.kind === "pi.compaction") {
			this.#addText("[the run was compacted to fit the context]");
		}
		this.#ui.requestRender();
	}

	/** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
	#tool(name: string, callId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(callId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(name, callId, args ?? {}, {}, this.#renderers[name], this.#ui, this.#cwd);
		component.setExpanded(this.#expanded);
		this.#chat.addChild(component);
		this.#cards.push(component);
		this.#tools.set(callId, component);
		return component;
	}

	#applyView(view: ConversationView): void {
		this.#agent = (view.docs["pi.agent"] ?? {}) as AgentState;
		this.#usage = totalUsage(view.docs["pi.usage"] as UsageState | undefined);
		const live = (view.docs["pi.live"] ?? {}) as LiveState;
		const newest = view.entries.at(-1);
		// An older frame than the entries on screen: its partial may already be an entry.
		if (newest === undefined || Number(newest.id) >= this.#lastEntry) {
			const message = live.generation?.message as AssistantMessage | undefined;
			if (message === undefined && this.#streaming !== undefined) {
				// A partial dropped without an entry, for example by a retry.
				this.#chat.removeChild(this.#streaming);
				this.#streaming = undefined;
			}
			if (message !== undefined) this.#syncStreaming(message);
			for (const slot of live.tools ?? []) {
				if (slot.status === "pending") continue;
				const card = this.#tool(slot.name, slot.callId);
				card.setArgsComplete();
				if (slot.status !== "running") continue;
				card.markExecutionStarted();
				if (slot.output !== undefined) {
					card.updateResult({ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false }, true);
				}
			}
			this.#syncStatus(live);
		}
		this.#editor.borderColor = theme.getThinkingBorderColor(this.#agent.thinkingLevel ?? "off");
		this.#syncFooter();
		this.#ui.requestRender();
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent();
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	// ─── Dock ───

	#syncStatus(live?: LiveState): void {
		const saavy = this.#saavy;
		let text = "";
		if (saavy.phase === "settling") {
			const waiting = saavy.memory.stats.unbuilt;
			text = waiting > 0 ? `Waiting for ${waiting} summaries… (esc cancels; answers anyway after 20s)` : "Starting…";
		} else if (saavy.phase === "running") {
			const retry = live?.generation?.retry;
			const tool = live?.tools?.find((slot) => slot.status === "running");
			text = retry !== undefined
				? `Retrying (attempt ${(live?.generation?.attempt ?? 0) + 1}): ${retry.error}`
				: tool !== undefined
					? `Running ${tool.name}… (esc to abort)`
					: "Working… (esc to abort)";
		}
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#status.clear();
		this.#loader?.stop();
		this.#loader = undefined;
		if (text !== "") {
			this.#loader = new Loader(this.#ui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), text);
			this.#loader.start();
			this.#status.addChild(this.#loader);
		}
		this.#ui.requestRender();
	}

	async #syncAgents(): Promise<void> {
		const agents = await this.#saavy.subagents();
		setAgentIds(agents.map((agent) => agent.id));
		this.#agents.clear();
		const working = agents.filter((agent) => agent.working);
		for (const agent of working) {
			const line = `${theme.fg("accent", `[${agent.id}]`)} ${theme.fg("muted", `working · ${agent.task.replace(/\s+/g, " ")}`)}`;
			this.#agents.addChild(new TruncatedText(line, 1, 0));
		}
		this.#ui.requestRender();
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		const color = level === "error" ? "error" : level === "warning" ? "warning" : "muted";
		const line = new TruncatedText(theme.fg(color, message), 1, 0);
		this.#notices.addChild(line);
		while (this.#notices.children.length > 4) this.#notices.removeChild(this.#notices.children[0]!);
		setTimeout(() => {
			this.#notices.removeChild(line);
			this.#ui.requestRender();
		}, level === "info" ? 6000 : 20000).unref();
		this.#ui.requestRender();
	}

	#syncFooter(): void {
		const { memory } = this.#saavy;
		const model = this.#agent.model === undefined ? "no model" : `${this.#agent.model.provider}/${this.#agent.model.modelId}`;
		const usage = this.#usage;
		const stats = [
			`↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`,
			...(usage.cacheRead > 0 ? [`R${formatTokens(usage.cacheRead)}`] : []),
			`$${usage.cost.total.toFixed(3)}`,
		];
		const m = memory.stats;
		const mem = `${m.messages} msgs · ${m.summaries} summaries${m.unbuilt > 0 ? ` · ${m.unbuilt} to summarize` : ""}${m.compacting > 0 ? " ⟳" : ""}`;
		this.#footerTop.setText(
			theme.fg("dim", `${model} · thinking ${this.#agent.thinkingLevel ?? "off"} · ${this.#agent.cwd ?? this.#cwd}`),
		);
		this.#footerBottom.setText(
			theme.fg(
				"dim",
				`${mem} · ${stats.join(" ")} · ${keyText("app.model.select")} model · ${keyText("app.thinking.cycle")} thinking · ${keyText("app.tools.expand")} expand · !cmd · /help`,
			),
		);
		this.#ui.requestRender();
	}
}

export async function runTui(saavy: Saavy): Promise<void> {
	const cwd = (await saavy.agent()).cwd ?? process.cwd();
	const settings = SettingsManager.create(cwd);
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	initTheme(settings.getTheme());
	const app = new SaavyTui(saavy, cwd);
	await app.start();
	await app.exited;
	app.stop();
}
