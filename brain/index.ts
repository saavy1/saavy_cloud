// saavy's brain: one Durable Object holding the memory (log, tree, view in SQLite), pi-durable's loop through
// Cloudflare's PiHarness, and a durable turn queue. Tools act on the user's desktop through a runner that dials in
// over a WebSocket; pi's coding tools see it as an ordinary ExecutionEnv.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCodemodeRuntime, DynamicWorkerExecutor, type CodemodeRuntimeHandle } from "@cloudflare/codemode";
import { type Api, clampThinkingLevel, type Model, Type } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AgentDoc, type Conversation, type Cursor, createRegistry, defineExtension, defineTool, type EntryRecord, type Extension, Harness, LiveDoc, type ModelRef, UserEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { type AuthEnv, getAuth, signedIn } from "../auth/auth.ts";
import { DEVICE_PAGE } from "../auth/device.ts";
import { glance } from "../core/glance.ts";
import { Memory } from "../core/memory.ts";
import type { MemoryStats, MsgInfo, NodeInfo, Phase } from "../core/protocol.ts";
import { CLIENT_TAG, Clients } from "./clients.ts";
import { type Config, ConfigStore, modelRef, ROUTING } from "./config.ts";
import { type Credential, NO_AMBIENT_AUTH, SqlCredentialStore } from "./credentials.ts";
import { DesktopConnector } from "./desktop.codemode.ts";
import { RemoteEnv } from "./env.ts";
import { createExtensions } from "./extension.ts";
import { desktopReplay } from "./replay.ts";
import { RUNNER_TAG, Runners } from "./runners.ts";
import { SqlMemoryStore } from "./store.ts";
import { createSubagentTools, SubagentsDoc, tellIn } from "./subagents.ts";
import { Turns } from "./turns.ts";

// The facet class the codemode runtime spawns; exported from the entry so it is on ctx.exports.
export { CodemodeRuntime } from "@cloudflare/codemode";

interface Env extends AuthEnv {
	Brain: DurableObjectNamespace<Brain>;
	AI: Ai;
	LOADER: WorkerLoader;
}

const context = BACKGROUND_CONTEXT;
const CODEMODE_DESCRIPTION =
	"Run a JavaScript async function body in a sandbox with `desktop.read({ path })` and `desktop.bash({ command })` (both resolve to strings). Return the value you want back. Use it to batch several desktop operations into one step.";

export class Brain extends DurableObject<Env> {
	readonly store = new SqlMemoryStore(this.ctx.storage);
	readonly settings = new ConfigStore(this.ctx.storage.sql);
	readonly ai = createAI({ binding: this.env.AI });
	/** Provider keys and OAuth tokens, set from a signed-in device. */
	readonly credentials = new SqlCredentialStore(this.ctx.storage.sql);
	readonly models = this.#createModels();
	readonly memory = new Memory(this.store, {
		models: this.models,
		driven: true,
		// One provider session for the compactor (OpenCode requires one; others keep its prefix cached).
		sessionId: `saavy-compactor-${this.ctx.id.toString().slice(0, 12)}`,
		current: () => {
			const { compactor } = this.settings.get();
			const ref = modelRef(compactor.model);
			const model = this.models.getModel(ref.provider, ref.modelId);
			return { model, thinking: model === undefined || compactor.thinking === "off" ? compactor.thinking : clampThinkingLevel(model, compactor.thinking) };
		},
	});
	readonly runners = new Runners(
		() => this.ctx.getWebSockets(RUNNER_TAG),
		(hello) => {
			this.store.setRunnerHome(hello.home);
			this.store.setRunnerHost(hello.host);
		},
	);
	readonly #envs = new Map<string, RemoteEnv>();

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const registry = createRegistry();
			const optchat = createExtensions(() => this.memory, { ...this.store.instructions, online: () => this.runners.count > 0 });
			const replay = desktopReplay(CodingTools.tools ?? []);
			const codemode = this.#codemodeExtension();
			// Subagents work like the main agent (coding tools on the desktop, memory, codemode) under their own prompt.
			const forSubagents: Extension[] = [CodingTools, replay, optchat.memory, codemode, optchat.sub];
			const subagents = createSubagentTools(
				{
					settle: (signal) => {
						this.turns.drive();
						return this.memory.settle(signal, 20_000);
					},
					render: () => this.memory.view.render(),
				},
				() => forSubagents,
				{
					model: () => {
						const model = this.settings.get().subagent?.model;
						return model === undefined ? undefined : modelRef(model);
					},
					thinking: () => this.settings.get().subagent?.thinking,
				},
			);
			const status = this.#statusExtension();
			forSubagents.push(status);
			const master = [CodingTools, replay, optchat.memory, codemode, optchat.ui, optchat.master, subagents, status];
			for (const extension of [...master, optchat.sub]) registry.install(extension);
			const pi = await Harness.open(
				storage,
				{
					models: this.models,
					registry,
					env: ({ cwd }) => this.desktop(cwd ?? this.cwd()),
					settings: { extensions: master },
					onReport: (error) => console.warn("pi report", error),
				},
				context,
			);
			const config = this.settings.get();
			// The working directory is pinned only when the user set one; otherwise it is the runner's home, resolved per call.
			const root = await pi.root(context, {
				agent: { model: modelRef(config.model), thinkingLevel: config.thinking, ...(config.cwd === undefined ? {} : { cwd: config.cwd }) },
			});
			await this.#catchUp(root);
			pi.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					// A subagent report in the outbox: hand it to the main agent.
					if (change.type === "document" && change.record.kind === "saavy.subagents" && change.conversationId === root.id) void this.turns.deliver();
					if (change.type !== "entry" || change.value.conversationId !== root.id) continue;
					this.memory.log.add(change.value);
					this.clients.broadcast({ t: "entry", entry: change.value });
				}
			});
			return pi;
		},
	});

	readonly turns = new Turns(this.ctx.storage.sql, () => ({
		memory: this.memory,
		harness: this.harness,
		root: () => this.root(),
		context,
		outbox: async () => (await this.#subagentState())?.outbox ?? [],
		ack: async (ids) => {
			const root = await this.root();
			await root.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, root.id);
				state.outbox = state.outbox.filter((item) => !ids.includes(item.id));
			}, context);
		},
	}));

	async #subagentState() {
		return (await this.harness.pi()).snapshot(SubagentsDoc, (await this.root()).id, context);
	}

	/** Each subagent: its task, whether it is working (and on which tool), whether it has reported. */
	async #subagents() {
		const pi = await this.harness.pi();
		const state = await this.#subagentState();
		const out = [];
		for (const [id, agent] of Object.entries(state?.agents ?? {})) {
			const live = await pi.snapshot(LiveDoc, agent.conversationId, context);
			const tool = live?.tools?.find((slot) => slot.status === "running")?.name;
			out.push({ id, task: agent.task, working: live?.run !== undefined, ...(tool === undefined ? {} : { tool }), reported: agent.reported.length > 0 });
		}
		return out;
	}

	/** A subagent's whole conversation as markdown, oldest first; null for an unknown id. */
	async #transcript(id: string): Promise<string | null> {
		const agent = (await this.#subagentState())?.agents[id];
		const conversation = agent === undefined ? undefined : await (await this.harness.pi()).conversation(agent.conversationId, context);
		if (conversation === undefined) return null;
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({}, 256, cursor, context);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		const fence = (text: string) => `\`\`\`\n${text.length > 1200 ? `${text.slice(0, 1200)}\n… (${text.length - 1200} more characters)` : text}\n\`\`\``;
		const parts: string[] = [];
		for (const entry of entries.reverse()) {
			for (const message of entry.model ?? []) {
				if (entry.kind === "pi.user" && message.role === "user") {
					// The first message starts with the view; only the task matters here.
					const blocks = typeof message.content === "string" ? [message.content] : message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
					parts.push(`**→ ${parts.length === 0 ? "task" : "message"}:** ${blocks.filter((block) => !block.startsWith("<chat>")).join("\n\n")}`);
				} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
					for (const block of message.content) {
						if (block.type === "text" && block.text.trim() !== "") parts.push(block.text.trim());
						else if (block.type === "toolCall") parts.push(`**▸ ${block.name}** \`${JSON.stringify(block.arguments).slice(0, 300)}\``);
					}
				} else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
					const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trimEnd();
					parts.push((message.isError ? "**error:**\n" : "") + fence(text));
				}
			}
		}
		return parts.join("\n\n");
	}

	readonly clients = new Clients(() => this.ctx.getWebSockets(CLIENT_TAG), this.#clientMethods());

	readonly webSockets = new WebSockets({
		// Runners and front ends speak saavy's own JSON frames; no agents protocol frames on their sockets.
		protocol: false,
		getConnectionTags: (_connection, ctx) => {
			const path = new URL(ctx.request.url).pathname;
			return path === "/ws/runner" ? [RUNNER_TAG] : path === "/ws/client" ? [CLIENT_TAG] : [];
		},
		handlers: {
			onConnect: (connection) => {
				if (connection.tags.includes(CLIENT_TAG)) void this.#follow();
			},
			onMessage: (connection, message) => {
				if (typeof message !== "string") return;
				if (connection.tags.includes(RUNNER_TAG)) this.runners.receive(message);
				else if (connection.tags.includes(CLIENT_TAG)) {
					void this.#follow();
					void this.clients.receive(connection as unknown as WebSocket, message);
				}
			},
		},
	});

	readonly lifecycle = Lifecycle.install(this).use(this.webSockets).use(this.harness).use(this.turns);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Every new message may make summaries buildable; the compactor job keeps the brain awake while they are.
		this.memory.log.subscribe(() => void this.turns.compact());
		this.memory.subscribe((event) => {
			if (event.type === "failed") {
				console.warn(`summary ${event.l}:${event.i} failed: ${event.error.message}`);
				this.clients.broadcast({ t: "notice", level: "warning", message: `summary ${event.l}:${event.i}: ${event.error.message}` });
			}
			this.#statsChanged();
		});
		this.memory.log.subscribe(() => this.#statsChanged());
		// Front ends still connected across a hibernation get their live feed back.
		if (this.clients.count > 0) void this.#follow();
	}

	// ─── Front ends ───

	#following: Promise<void> | undefined;
	#phase: Phase = "idle";
	#live: Record<string, unknown> | undefined;
	/** The newest live frame, for a front end that just connected. */
	#viewFrame: { docs: Record<string, unknown>; last: unknown } | undefined;
	#viewTimer: ReturnType<typeof setTimeout> | undefined;
	#statsTimer: ReturnType<typeof setTimeout> | undefined;

	/** Follow pi's live view of the main conversation while front ends are connected. */
	#follow(): Promise<void> {
		this.#following ??= (async () => {
			const view = await (await this.root()).viewState(context);
			let latest = view.value;
			const send = () => {
				this.#viewTimer = undefined;
				const docs = latest.docs;
				this.#live = docs["pi.live"];
				this.#viewFrame = { docs: { "pi.agent": docs["pi.agent"], "pi.usage": docs["pi.usage"], "pi.live": docs["pi.live"] }, last: latest.entries.at(-1)?.id ?? null };
				this.clients.broadcast({ t: "view", ...this.#viewFrame });
				this.#updatePhase();
			};
			send();
			view.subscribe((value) => {
				latest = value;
				if (this.clients.count === 0) return;
				// Partials commit often; a front end needs ten frames a second at most.
				this.#viewTimer ??= setTimeout(send, 100);
			});
		})().catch((error: unknown) => {
			this.#following = undefined;
			console.warn("following the view failed", error);
		});
		return this.#following;
	}

	/** running while pi has a run, settling while messages wait in the inbox, else idle. */
	#updatePhase(): void {
		const phase: Phase = this.#live?.run !== undefined ? "running" : this.turns.queued() > 0 ? "settling" : "idle";
		if (phase === this.#phase) return;
		this.#phase = phase;
		this.clients.broadcast({ t: "phase", phase });
	}

	#stats(): MemoryStats {
		const view = this.memory.view;
		return {
			messages: this.memory.log.length,
			summaries: this.memory.tree.size,
			viewBytes: view.size(),
			viewLines: view.parts.length,
			depth: Math.max(0, ...view.parts.map((part) => part.l)),
			unbuilt: view.unbuilt(),
			compacting: this.memory.running,
		};
	}

	#statsChanged(): void {
		if (this.clients.count === 0) return;
		this.#statsTimer ??= setTimeout(() => {
			this.#statsTimer = undefined;
			this.clients.broadcast({ t: "memory", stats: this.#stats() });
		}, 300);
	}

	/** What front ends may call. */
	#clientMethods() {
		const pi = () => this.harness.pi();
		return {
			hello: async () => {
				await this.#follow();
				return { phase: this.#phase, stats: this.#stats(), config: { ...this.settings.get(), cwd: this.cwd() }, runners: this.runners.count, view: this.#viewFrame ?? null };
			},
			recentEntries: async (limit: number) => [...(await (await this.root()).entries({}, Math.min(limit, 500), undefined, context)).items].reverse(),
			send: async (text: string) => {
				const id = await this.turns.enqueue(text);
				this.#updatePhase();
				return id;
			},
			abort: async () => this.#abort(),
			note: async (text: string) => this.#note(text),
			agent: async () => (await pi()).snapshot(AgentDoc, (await this.root()).id, context),
			models: async () => [...this.models.getModels("cloudflare"), ...this.models.getModels("openrouter")],
			setModel: async (ref: ModelRef) => this.#thinkingFor((await this.configure({ model: `${ref.provider}/${ref.modelId}` })).thinking),
			setThinking: async (level: Config["thinking"]) => this.#thinkingFor((await this.configure({ thinking: level })).thinking),
			setCwd: async (dir: string) => this.#setCwd(dir),
			setCompactor: async (model: string | undefined, thinking?: Config["compactor"]["thinking"]) => {
				const current = this.settings.get().compactor;
				return this.settings.set({ compactor: { model: model ?? current.model, thinking: thinking ?? current.thinking } }).compactor;
			},
			config: async () => ({ ...this.settings.get(), cwd: this.cwd() }),
			setSubagentModel: async (model: string | undefined, thinking?: Config["thinking"]) => {
				const subagent = model === undefined && thinking === undefined ? undefined : { ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) };
				return this.settings.set({ subagent }).subagent ?? null;
			},
			subagents: async () => this.#subagents(),
			/** Provider credentials: which are set (never their secrets), set one, remove one. */
			credentials: async () => this.credentials.list(),
			setCredential: async (provider: string, credential: Credential) => {
				if (this.models.getProvider(provider) === undefined) throw new Error(`Unknown provider ${provider}`);
				await this.credentials.modify(provider, async () => credential);
				return this.models.getModels(provider).length;
			},
			deleteCredential: async (provider: string) => this.credentials.delete(provider),
			transcript: async (id: string) => this.#transcript(id),
			tell: async (id: string, text: string) => {
				const root = await this.root();
				const group = `user:${Date.now()}:${Math.random().toString(36).slice(2)}`;
				return root.commit((tx) => tellIn(tx, root.id, id, `(from the user) ${text}`, group), context);
			},
			stop: async (id: string) => {
				const agent = (await this.#subagentState())?.agents[id];
				const conversation = agent === undefined ? undefined : await (await this.harness.pi()).conversation(agent.conversationId, context);
				if (conversation === undefined) return false;
				await conversation.abort(context);
				return true;
			},
			usage: async () => (await pi()).usage(context),
			stats: async () => this.#stats(),
			view: async () => this.memory.view.render(),
			parts: async () => this.memory.view.parts,
			zoom: async (id: number, n: number) => this.memory.zoom(id, n),
			search: async (query: string) => this.memory.search(query),
			date: async (id: number) => this.memory.date(id),
			glance: async (offsetMinutes: number) => glance(this.memory, offsetMinutes),
			nodes: async (list: { l: number; i: number }[]): Promise<NodeInfo[]> => list.slice(0, 2000).map(({ l, i }) => ({ l, i, text: this.memory.tree.get(l, i)?.text ?? null })),
			msgs: async (list: number[]): Promise<MsgInfo[]> =>
				list.slice(0, 2000).flatMap((i) => {
					const message = this.memory.log.at(i);
					return message === undefined ? [] : [{ i, kind: message.kind, text: message.text, date: message.date }];
				}),
		};
	}

	/** The level the main model really runs at for `level`. */
	#thinkingFor(level: Config["thinking"]): string {
		const ref = modelRef(this.settings.get().model);
		const model = this.models.getModel(ref.provider, ref.modelId);
		return model === undefined ? level : clampThinkingLevel(model, level);
	}

	/** Stop the running call; messages still waiting for summaries are logged unanswered (spec §6). */
	async #abort(): Promise<void> {
		const waiting = this.turns.drain();
		for (const text of waiting) await this.#note(text);
		if (this.#live?.run !== undefined) await this.harness.abort();
		this.#updatePhase();
	}

	/** Put a message in the log without starting a turn. */
	async #note(text: string): Promise<void> {
		const entry = { kind: UserEntry.kind, model: [{ role: "user" as const, content: text, timestamp: Date.now() }] };
		await (await this.root()).submit({ type: "write", entry }, context);
	}

	async #setCwd(dir: string): Promise<string> {
		const home = this.store.runnerHome() ?? "/";
		const base = this.cwd();
		const expanded = dir.replace(/^~(?=$|\/)/, home);
		const parts = (expanded.startsWith("/") ? expanded : `${base}/${expanded}`).split("/");
		const out: string[] = [];
		for (const part of parts) {
			if (part === "" || part === ".") continue;
			if (part === "..") out.pop();
			else out.push(part);
		}
		const cwd = `/${out.join("/")}`;
		const exists = await this.desktop(cwd).fileInfo(cwd, context);
		if (!exists.ok || exists.value.kind !== "directory") throw new Error(`No directory ${cwd} on the desktop`);
		await this.configure({ cwd });
		return cwd;
	}

	/** The working directory: the one the user set, else the runner's home. */
	cwd(config: Config = this.settings.get()): string {
		return config.cwd ?? this.store.runnerHome() ?? "/";
	}

	/** The desktop as an ExecutionEnv at `cwd`. */
	desktop(cwd: string = this.cwd()): RemoteEnv {
		let env = this.#envs.get(cwd);
		if (env === undefined) this.#envs.set(cwd, (env = new RemoteEnv(cwd, this.runners.send)));
		return env;
	}

	async root(): Promise<Conversation> {
		return (await this.harness.pi()).root(context);
	}

	/** Log the root conversation's entries committed while no one was following (the first open, a lost listener). */
	async #catchUp(root: Conversation): Promise<void> {
		const last = this.store.lastEntry();
		const missing = [];
		let cursor;
		do {
			const page = await root.entries({}, 256, cursor, context);
			const newer = page.items.filter((entry) => Number(entry.id) > last);
			missing.push(...newer);
			cursor = newer.length < page.items.length ? undefined : page.next;
		} while (cursor !== undefined);
		for (const entry of missing.reverse()) this.memory.log.add(entry);
	}

	/** Workers AI plus OpenRouter's catalog, every OpenRouter model routed through AI Gateway (a BYOK key there). */
	/**
	 * Providers called directly (no gateway in the way), with the credentials the brain holds: OpenCode Go and
	 * OpenRouter (its models carrying the provider pins in ROUTING), plus Workers AI through the AI binding.
	 */
	#createModels(): Models {
		const models = createModels({ credentials: this.credentials, authContext: NO_AMBIENT_AUTH });
		models.setProvider(this.ai.provider);
		models.setProvider(opencodeGoProvider());
		const openrouter = openrouterProvider();
		const pinned = openrouter.getModels().map((model) => {
			const routing = ROUTING[model.id];
			return routing === undefined ? model : { ...model, compat: { ...model.compat, openRouterRouting: routing } };
		});
		models.setProvider(
			new Proxy(openrouter, {
				get: (target, key) => {
					if (key === "getModels") return () => pinned;
					if (key === "getAllModels") return undefined;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as Provider,
		);
		return models;
	}

	#codemode: CodemodeRuntimeHandle | undefined;

	/** Cloudflare codemode over the desktop; scripts run in Dynamic Workers, completed calls replay. */
	get codemode(): CodemodeRuntimeHandle {
		this.#codemode ??= createCodemodeRuntime({
			ctx: this.ctx,
			executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
			connectors: [new DesktopConnector(this.ctx, this.env, () => this.desktop())],
		});
		return this.#codemode;
	}

	/** status: how the agent runs right now, the things too changeable for the prompt. */
	#statusExtension() {
		return defineExtension({
			name: "saavy-status",
			tools: [
				defineTool({
					name: "status",
					description:
						"How you run right now: your model and thinking level, the compactor's model, the working directory, whether the user's desktop runner is connected (and which machine), connected front ends, memory size, and the current time (UTC).",
					parameters: Type.Object({}),
					replay: "safe",
					execute: async () => {
						const config = this.settings.get();
						const view = this.memory.view;
						const lines = [
							`now: ${new Date().toISOString()} (UTC)`,
							`model: ${config.model} (thinking ${config.thinking}); compactor: ${config.compactor.model} (thinking ${config.compactor.thinking})`,
							`where you run: a Cloudflare Durable Object (the brain); your tools act on the user's machine through its runner`,
							`desktop runner: ${this.runners.count > 0 ? `connected (${this.store.runnerHost() ?? "unknown host"})` : "offline: file and shell tools will wait, then fail"}`,
							`working directory: ${this.cwd(config)}`,
							`front ends connected: ${this.clients.count}`,
							`memory: ${this.memory.log.length} messages, ${this.memory.tree.size} summaries, view ${view.parts.length} lines (${view.size()} bytes), ${view.unbuilt()} lines not summarized yet`,
						];
						return { content: [{ type: "text", text: lines.join("\n") }] };
					},
				}),
			],
		});
	}

	#codemodeExtension() {
		return defineExtension({
			name: "saavy-codemode",
			tools: [
				defineTool({
					name: "codemode",
					description: CODEMODE_DESCRIPTION,
					parameters: Type.Object({ code: Type.String() }),
					replay: "unsafe",
					execute: async (args) => {
						const output = await this.codemode.execute({ code: args.code });
						return { content: [{ type: "text", text: JSON.stringify(output) }], isError: output.status === "error" };
					},
				}),
			],
		});
	}

	// ─── RPC for the Worker's HTTP API ───

	/** Queue a message; its id. */
	async send(text: string): Promise<{ id: string }> {
		return { id: await this.turns.enqueue(text) };
	}

	/** Queue a message and wait for the answer to the turn it went out in. */
	async prompt(text: string): Promise<{ status: string; reason?: string; answer: string }> {
		const id = await this.turns.enqueue(text);
		let operation: string | undefined;
		for (const deadline = Date.now() + 5 * 60_000; (operation = this.turns.operation(id)) === undefined; ) {
			if (Date.now() > deadline) return { status: "queued", answer: "" };
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		const result = await this.harness.wait(operation);
		return { status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }), answer: result.text ?? "" };
	}

	async status(): Promise<unknown> {
		const config = this.settings.get();
		return {
			runners: this.runners.count,
			config: { ...config, cwd: this.cwd(config) },
			busy: await this.harness.session().busy(),
			queued: this.turns.queued(),
			memory: { messages: this.memory.log.length, summaries: this.memory.tree.size, viewBytes: this.memory.view.size(), unbuilt: this.memory.view.unbuilt(), compacting: this.memory.running },
		};
	}

	async view(): Promise<string> {
		return this.memory.view.render();
	}

	async search(query: string): Promise<string> {
		return this.memory.search(query);
	}

	/** Change settings; the main model, thinking level and working directory apply from the next request on. */
	async configure(change: Partial<Config>): Promise<Config> {
		if (change.model !== undefined) {
			const ref = modelRef(change.model);
			if (this.models.getModel(ref.provider, ref.modelId) === undefined) throw new Error(`Unknown model ${change.model}`);
		}
		const config = this.settings.set(change);
		if (change.model !== undefined || change.thinking !== undefined || change.cwd !== undefined) {
			const ref = modelRef(config.model);
			const model = this.models.getModel(ref.provider, ref.modelId)!;
			await (await this.root()).configure({ model: ref, thinkingLevel: clampThinkingLevel(model, config.thinking), cwd: config.cwd ?? null }, context);
		}
		return config;
	}

	async runCode(code: string): Promise<unknown> {
		return JSON.parse(JSON.stringify(await this.codemode.execute({ code })));
	}

	async transcript(): Promise<unknown> {
		return { pending: await this.harness.pending(), messages: JSON.parse(JSON.stringify(await this.harness.messages())) };
	}
}

/** Who is calling: a signed-in device (bearer session token, or the session cookie in a browser). */
async function caller(request: Request, env: Env): Promise<string | undefined> {
	return (await signedIn(env, request.headers))?.name;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		// Signing in is the one thing open to everyone (rate limited, and only allowlisted GitHub accounts get through).
		if (url.pathname.startsWith("/api/auth/")) return getAuth(env).auth.handler(request);
		if (url.pathname === "/device") return new Response(DEVICE_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		const who = await caller(request, env);
		if (who === undefined) return Response.json({ error: "Sign in first: saavy auth login" }, { status: 401 });
		if (url.pathname === "/api/me") return Response.json({ name: who });
		const brain = env.Brain.get(env.Brain.idFromName("main"));
		const body = async <T>() => (await request.json()) as T;
		const post = request.method === "POST";
		try {
			switch (url.pathname) {
				case "/ws/runner":
				case "/ws/client":
					return brain.fetch(request);
				case "/api/status":
					return Response.json(await brain.status());
				case "/api/view":
					return new Response(await brain.view());
				case "/api/search":
					return new Response(await brain.search(url.searchParams.get("q") ?? ""));
				case "/api/transcript":
					return Response.json(await brain.transcript());
			}
			if (post && url.pathname === "/api/send") return Response.json(await brain.send((await body<{ text: string }>()).text));
			if (post && url.pathname === "/api/prompt") return Response.json(await brain.prompt((await body<{ text: string }>()).text));
			if (post && url.pathname === "/api/config") return Response.json(await brain.configure(await body<Partial<Config>>()));
			if (post && url.pathname === "/api/codemode") return Response.json(await brain.runCode((await body<{ code: string }>()).code));
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
