// The brain, as the front ends see it: the same surface the local agent offered (send, abort, phase, entries, the live
// view, memory, models), over one WebSocket to the brain on Cloudflare. Reconnects on its own; entries committed while
// it was away are fetched and delivered in order.
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView, EntryRecord, ModelRef, UsageState } from "@earendil-works/pi-durable";
import type { Glance } from "../core/glance.ts";
import type { MemoryStats, MsgInfo, NodeInfo, Phase, ServerFrame } from "../core/protocol.ts";

export type { Phase } from "../core/protocol.ts";
export type Thinking = ModelThinkingLevel | "off";

export type HostEvent =
	| { type: "phase"; phase: Phase }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string }
	| { type: "connection"; connected: boolean };

export interface BrainConfig {
	readonly model: string;
	readonly thinking: ModelThinkingLevel;
	readonly compactor: { readonly model: string; readonly thinking: Thinking };
	readonly cwd: string;
	readonly subagent?: { readonly model?: string; readonly thinking?: ModelThinkingLevel };
}

export interface SubagentSummary {
	readonly id: string;
	readonly task: string;
	readonly working: boolean;
	readonly tool?: string;
	readonly reported: boolean;
}

const RECONNECT_MS = [500, 1000, 2000, 5000, 10_000];
const CALL_TIMEOUT_MS = 5 * 60_000;

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Memory counters pushed by the brain, and queries answered by it. */
export class RemoteMemory {
	stats: MemoryStats = { messages: 0, summaries: 0, viewBytes: 0, viewLines: 0, depth: 0, unbuilt: 0, compacting: 0 };
	readonly #brain: RemoteSaavy;
	readonly #listeners = new Set<() => void>();
	readonly #nodes = new Map<string, string | null>();
	readonly #msgs = new Map<number, MsgInfo>();

	constructor(brain: RemoteSaavy) {
		this.#brain = brain;
	}

	update(stats: MemoryStats): void {
		this.stats = stats;
		for (const listener of this.#listeners) listener();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get running(): number {
		return this.stats.compacting;
	}

	view(): Promise<string> {
		return this.#brain.call("view");
	}
	parts(): Promise<{ l: number; i: number }[]> {
		return this.#brain.call("parts");
	}
	zoom(id: number, n: number): Promise<string> {
		return this.#brain.call("zoom", id, n);
	}
	search(query: string): Promise<string> {
		return this.#brain.call("search", query);
	}
	date(id: number): Promise<string> {
		return this.#brain.call("date", id);
	}
	glance(): Promise<Glance> {
		return this.#brain.call("glance", new Date().getTimezoneOffset());
	}

	/** Fetch the nodes and messages not cached yet; then node() and msg() answer them. Nodes and messages never change. */
	async load(nodes: readonly { l: number; i: number }[], msgs: readonly number[]): Promise<void> {
		const wantNodes = nodes.filter(({ l, i }) => this.#nodes.get(`${l}:${i}`) == null);
		const wantMsgs = [...new Set(msgs)].filter((i) => !this.#msgs.has(i));
		const [gotNodes, gotMsgs] = await Promise.all([
			wantNodes.length === 0 ? [] : this.#brain.call<NodeInfo[]>("nodes", wantNodes),
			wantMsgs.length === 0 ? [] : this.#brain.call<MsgInfo[]>("msgs", wantMsgs),
		]);
		for (const node of gotNodes) this.#nodes.set(`${node.l}:${node.i}`, node.text);
		for (const msg of gotMsgs) this.#msgs.set(msg.i, msg);
	}

	node(l: number, i: number): string | undefined {
		return this.#nodes.get(`${l}:${i}`) ?? undefined;
	}

	msg(i: number): MsgInfo | undefined {
		return this.#msgs.get(i);
	}
}

/** The brain's models, fetched once; the picker and thinking levels read them synchronously. */
export class RemoteModels {
	#models: Model<Api>[] = [];

	set(models: Model<Api>[]): void {
		this.#models = models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.#models.find((model) => model.provider === provider && model.id === id);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.#models;
	}
}

export class RemoteSaavy {
	/** Where this front end keeps its own files (composer history). */
	readonly home: string;
	readonly memory = new RemoteMemory(this);
	readonly models = new RemoteModels();
	/** The local agent asked the user before restarting; nothing asks here yet. */
	approver: ((question: string) => Promise<boolean>) | undefined;
	config: BrainConfig = { model: "", thinking: "off", compactor: { model: "", thinking: "off" }, cwd: "/" };
	runners = 0;
	readonly root = { viewState: (_context?: unknown) => this.#viewState() };

	readonly #url: string;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<(event: HostEvent) => void>();
	readonly #entryListeners = new Set<(entry: EntryRecord) => void>();
	readonly #viewListeners = new Set<(view: ConversationView) => void>();
	#socket: WebSocket | undefined;
	#nextId = 1;
	#phase: Phase = "idle";
	#view: ConversationView = { conversation: {} as ConversationView["conversation"], entries: [], docs: {} };
	#lastEntry = -1;
	#attempt = 0;
	#closed = false;
	#connected: Promise<void>;
	#onConnected: () => void = () => {};

	readonly #token: string;

	private constructor(url: string, token: string, home: string) {
		this.#url = url;
		this.#token = token;
		this.home = home;
		this.#connected = new Promise((resolve) => {
			this.#onConnected = resolve;
		});
	}

	/** Connect to the brain at `base` (https://… or http://…) with `token`; resolves once the first hello is in. */
	static async connect(base: string, token: string, home: string): Promise<RemoteSaavy> {
		const url = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/ws/client`;
		const brain = new RemoteSaavy(url, token, home);
		brain.#open();
		await brain.#connected;
		brain.models.set(await brain.call<Model<Api>[]>("models"));
		return brain;
	}

	#open(): void {
		// The token rides in a header, never in the URL (Node's WebSocket takes headers).
		const socket = new WebSocket(this.#url, { headers: { authorization: `Bearer ${this.#token}` } } as unknown as string[]);
		this.#socket = socket;
		socket.addEventListener("open", () => {
			this.#attempt = 0;
			void this.#hello();
		});
		socket.addEventListener("message", (event) => this.#receive(String(event.data)));
		socket.addEventListener("close", () => {
			if (this.#socket === socket) this.#socket = undefined;
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("The connection to the brain dropped."));
			}
			this.#pending.clear();
			if (this.#closed) return;
			this.#emit({ type: "connection", connected: false });
			const delay = RECONNECT_MS[Math.min(this.#attempt++, RECONNECT_MS.length - 1)]!;
			setTimeout(() => this.#open(), delay).unref();
		});
		socket.addEventListener("error", () => {});
	}

	async #hello(): Promise<void> {
		try {
			const hello = await this.call<{ phase: Phase; stats: MemoryStats; config: BrainConfig; runners: number; view: { docs: Record<string, unknown>; last: unknown } | null }>("hello");
			if (hello.view !== null) this.#receive(JSON.stringify({ t: "view", ...hello.view }));
			this.config = hello.config;
			this.runners = hello.runners;
			this.memory.update(hello.stats);
			this.#setPhase(hello.phase);
			// Entries committed while away (after the first connection), in order.
			if (this.#lastEntry >= 0) {
				for (const entry of await this.recentEntries(200)) if (Number(entry.id) > this.#lastEntry) this.#entry(entry);
				this.#emit({ type: "connection", connected: true });
			}
			this.#onConnected();
		} catch (error) {
			this.#emit({ type: "notice", level: "error", message: `brain: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	#receive(text: string): void {
		const frame = JSON.parse(text) as ServerFrame;
		switch (frame.t) {
			case "reply": {
				const pending = this.#pending.get(frame.id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.#pending.delete(frame.id);
				if (frame.ok) pending.resolve(frame.value);
				else pending.reject(new Error(frame.error));
				return;
			}
			case "entry":
				return this.#entry(frame.entry as EntryRecord);
			case "view": {
				const last = frame.last === null ? [] : [{ id: frame.last } as unknown as EntryRecord];
				this.#view = { conversation: this.#view.conversation, entries: last, docs: frame.docs as ConversationView["docs"] };
				for (const listener of this.#viewListeners) listener(this.#view);
				return;
			}
			case "phase":
				return this.#setPhase(frame.phase);
			case "memory":
				return this.memory.update(frame.stats);
			case "notice":
				return this.#emit({ type: "notice", level: frame.level, message: frame.message });
		}
	}

	#entry(entry: EntryRecord): void {
		const id = Number(entry.id);
		if (id <= this.#lastEntry) return;
		this.#lastEntry = id;
		for (const listener of this.#entryListeners) listener(entry);
	}

	#setPhase(phase: Phase): void {
		if (phase === this.#phase) return;
		this.#phase = phase;
		this.#emit({ type: "phase", phase });
	}

	#emit(event: HostEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	/** One call to the brain. */
	call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		const socket = this.#socket;
		if (socket === undefined || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected to the brain (reconnecting)."));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`The brain did not answer ${method}.`));
			}, CALL_TIMEOUT_MS);
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			socket.send(JSON.stringify({ t: "call", id, method, args }));
		});
	}

	async #viewState() {
		return {
			value: this.#view,
			subscribe: (listener: (view: ConversationView) => void) => {
				this.#viewListeners.add(listener);
				return () => this.#viewListeners.delete(listener);
			},
			dispose: () => {},
		};
	}

	get phase(): Phase {
		return this.#phase;
	}

	subscribe(listener: (event: HostEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Every entry of the main conversation as it commits, once each, in order. */
	onEntry(listener: (entry: EntryRecord) => void): () => void {
		this.#entryListeners.add(listener);
		return () => this.#entryListeners.delete(listener);
	}

	async recentEntries(limit: number): Promise<EntryRecord[]> {
		const entries = await this.call<EntryRecord[]>("recentEntries", limit);
		for (const entry of entries) this.#lastEntry = Math.max(this.#lastEntry, Number(entry.id));
		return entries;
	}

	async send(text: string): Promise<void> {
		await this.call("send", text);
	}
	async abort(): Promise<void> {
		await this.call("abort");
	}
	async note(text: string): Promise<void> {
		await this.call("note", text);
	}
	async agent(): Promise<AgentState> {
		return (await this.call<AgentState | null>("agent")) ?? {};
	}
	setModel(ref: ModelRef): Promise<string> {
		return this.call("setModel", ref);
	}
	setThinking(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
		return this.call("setThinking", level);
	}
	setCwd(dir: string): Promise<string> {
		return this.call("setCwd", dir);
	}
	async setCompactor(model: string | undefined, thinking?: Thinking): Promise<void> {
		const compactor = await this.call<BrainConfig["compactor"]>("setCompactor", model, thinking);
		this.config = { ...this.config, compactor };
	}
	usage(): Promise<UsageState> {
		return this.call("usage");
	}

	/** The subagents, polled by the front ends; empty while disconnected. */
	async subagents(): Promise<SubagentSummary[]> {
		return this.call<SubagentSummary[]>("subagents").catch(() => []);
	}
	/** A subagent's whole run as markdown; undefined for an unknown id. */
	async transcript(id: string): Promise<string | undefined> {
		return (await this.call<string | null>("transcript", id)) ?? undefined;
	}
	tell(id: string, text: string): Promise<boolean> {
		return this.call("tell", id, text);
	}
	stop(id: string): Promise<boolean> {
		return this.call("stop", id);
	}
	async setSubagentModel(model: string | undefined, thinking?: ModelThinkingLevel): Promise<void> {
		const subagent = await this.call<BrainConfig["subagent"] | null>("setSubagentModel", model, thinking);
		this.config = { ...this.config, subagent: subagent ?? undefined };
	}

	/** Self-refreshing UIs live in the local agent only, for now. */
	refresh(_handle: string): boolean {
		return false;
	}

	close(): void {
		this.#closed = true;
		this.#socket?.close();
	}
}
