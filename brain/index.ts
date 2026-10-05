// saavy's brain: one Durable Object holding the memory (log, tree, view in SQLite), pi-durable's loop through
// Cloudflare's PiHarness, and a durable turn queue. Tools act on the user's desktop through a runner that dials in
// over a WebSocket; pi's coding tools see it as an ordinary ExecutionEnv.
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCodemodeRuntime, DynamicWorkerExecutor, type CodemodeRuntimeHandle } from "@cloudflare/codemode";
import { type Api, clampThinkingLevel, type Model, Type } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { type Conversation, createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { Memory } from "../core/memory.ts";
import { type Config, ConfigStore, modelRef, ROUTING } from "./config.ts";
import { DesktopConnector } from "./desktop.codemode.ts";
import { RemoteEnv } from "./env.ts";
import { createExtensions } from "./extension.ts";
import { RUNNER_TAG, Runners } from "./runners.ts";
import { SqlMemoryStore } from "./store.ts";
import { Turns } from "./turns.ts";

// The facet class the codemode runtime spawns; exported from the entry so it is on ctx.exports.
export { CodemodeRuntime } from "@cloudflare/codemode";

interface Env {
	Brain: DurableObjectNamespace<Brain>;
	AI: Ai;
	SAAVY_TOKEN: string;
	LOADER: WorkerLoader;
}

const context = BACKGROUND_CONTEXT;
const CODEMODE_DESCRIPTION =
	"Run a JavaScript async function body in a sandbox with `desktop.read({ path })` and `desktop.bash({ command })` (both resolve to strings). Return the value you want back. Use it to batch several desktop operations into one step.";

export class Brain extends DurableObject<Env> {
	readonly store = new SqlMemoryStore(this.ctx.storage);
	readonly settings = new ConfigStore(this.ctx.storage.sql);
	readonly ai = createAI({ binding: this.env.AI });
	readonly models = this.#createModels();
	readonly memory = new Memory(this.store, {
		models: this.models,
		driven: true,
		current: () => {
			const { compactor } = this.settings.get();
			const ref = modelRef(compactor.model);
			const model = this.models.getModel(ref.provider, ref.modelId);
			return { model, thinking: model === undefined || compactor.thinking === "off" ? compactor.thinking : clampThinkingLevel(model, compactor.thinking) };
		},
	});
	readonly runners = new Runners(
		() => this.ctx.getWebSockets(RUNNER_TAG),
		(hello) => this.store.setRunnerHome(hello.home),
	);
	readonly #envs = new Map<string, RemoteEnv>();

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			const registry = createRegistry();
			const extensions = [CodingTools, ...createExtensions(() => this.memory, this.store.instructions), this.#codemodeExtension()];
			for (const extension of extensions) registry.install(extension);
			const pi = await Harness.open(
				storage,
				{ models: this.models, registry, env: ({ cwd }) => this.desktop(cwd ?? this.cwd()), onReport: (error) => console.warn("pi report", error) },
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
					if (change.type === "entry" && change.value.conversationId === root.id) this.memory.log.add(change.value);
				}
			});
			return pi;
		},
	});

	readonly turns = new Turns(this.ctx.storage.sql, () => ({ memory: this.memory, harness: this.harness, root: () => this.root(), context }));

	readonly webSockets = new WebSockets({
		// The runner speaks only its own JSON frames; no agents protocol frames on its socket.
		protocol: (_connection, ctx) => new URL(ctx.request.url).pathname !== "/ws/runner",
		getConnectionTags: (_connection, ctx) => (new URL(ctx.request.url).pathname === "/ws/runner" ? [RUNNER_TAG] : []),
		handlers: {
			onMessage: (connection, message) => {
				if (typeof message === "string" && connection.tags.includes(RUNNER_TAG)) this.runners.receive(message);
			},
		},
	});

	readonly lifecycle = Lifecycle.install(this).use(this.webSockets).use(this.harness).use(this.turns);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Every new message may make summaries buildable; the compactor job keeps the brain awake while they are.
		this.memory.log.subscribe(() => void this.turns.compact());
		this.memory.subscribe((event) => {
			if (event.type === "failed") console.warn(`summary ${event.l}:${event.i} failed: ${event.error.message}`);
		});
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
	#createModels(): Models {
		const models = createModels();
		models.setProvider(this.ai.provider);
		const provider = this.ai.provider;
		const openrouter = Object.values(OPENROUTER_MODELS).map((model) => {
			const routing = ROUTING[model.id];
			const routed = routing === undefined ? model : { ...model, compat: { ...model.compat, openRouterRouting: routing } };
			return this.ai(routed as Model<Api>);
		});
		models.setProvider(
			new Proxy(provider, {
				get: (target, key) => {
					if (key === "id") return "openrouter";
					if (key === "name") return "OpenRouter (AI Gateway)";
					if (key === "getModels") return () => openrouter;
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

function authorized(request: Request, env: Env): boolean {
	const url = new URL(request.url);
	const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
	return token !== null && token !== undefined && env.SAAVY_TOKEN !== undefined && token === env.SAAVY_TOKEN;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
		const brain = env.Brain.get(env.Brain.idFromName("main"));
		const body = async <T>() => (await request.json()) as T;
		const post = request.method === "POST";
		try {
			switch (url.pathname) {
				case "/ws/runner":
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
