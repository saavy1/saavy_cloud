// Phase-0 spike: saavy's brain as a Durable Object running pi-durable through Cloudflare's PiHarness, with tools that
// execute on a desktop runner connected over an outbound WebSocket.
import { DurableObject } from "cloudflare:workers";
import { createCodemodeRuntime, DynamicWorkerExecutor, type CodemodeRuntimeHandle } from "@cloudflare/codemode";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { DesktopConnector } from "./desktop.codemode.ts";

// The facet class the codemode runtime spawns; exported from the entry so it is on ctx.exports.
export { CodemodeRuntime } from "@cloudflare/codemode";

interface Env {
	Brain: DurableObjectNamespace<Brain>;
	AI: Ai;
	SAAVY_TOKEN: string;
	LOADER: WorkerLoader;
}

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";
const RUNNER_TAG = "runner";

type RunnerReply = { id: string; ok: true; result: string } | { id: string; ok: false; error: string };

export class Brain extends DurableObject<Env> {
	readonly ai = createAI({ binding: this.env.AI });
	readonly registry = createRegistry();
	/** Calls waiting for the runner; in memory, so an eviction mid-call leaves pi's replay rules to decide. */
	readonly #pending = new Map<string, { resolve: (reply: RunnerReply) => void; timer: ReturnType<typeof setTimeout> }>();

	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
			this.registry.install({
				name: "saavy-spike",
				sections: [
					{
						key: "preamble",
						render: () =>
							"You are saavy, a coding agent whose tools run on the user's desktop through a runner. Use remote_read and remote_bash for anything on their machine. Be concise.",
						tag: false,
					},
				],
				tools: [this.#remoteTool("remote_read", "Read a text file on the user's desktop.", { path: { type: "string" } }, "safe"), this.#remoteTool("remote_bash", "Run a bash command on the user's desktop; returns stdout, stderr and the exit code.", { command: { type: "string" } }, "unsafe"), this.#codemodeTool()],
			});
			const models = createModels();
			models.setProvider(this.ai.provider);
			models.setProvider(this.#openrouter());
			return Harness.open(storage, { models, registry: this.registry, onReport: (error) => console.warn("pi report", error) }, context);
		},
		defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" },
	});

	readonly webSockets = new WebSockets({
		// The runner speaks only our JSON RPC; no agents protocol frames on its socket.
		protocol: (_connection, ctx) => new URL(ctx.request.url).pathname !== "/ws/runner",
		getConnectionTags: (_connection, ctx) => (new URL(ctx.request.url).pathname === "/ws/runner" ? [RUNNER_TAG] : []),
		handlers: {
			onMessage: (_connection, message) => {
				if (typeof message !== "string") return;
				const reply = JSON.parse(message) as RunnerReply;
				const pending = this.#pending.get(reply.id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.#pending.delete(reply.id);
				pending.resolve(reply);
			},
		},
	});

	readonly lifecycle = Lifecycle.install(this).use(this.webSockets).use(this.harness);

	/** OpenRouter's catalog as its own provider, every model routed through AI Gateway (the key is a gateway BYOK key). */
	#openrouter(): Provider {
		const provider = this.ai.provider;
		const models = Object.values(OPENROUTER_MODELS).map((model) => this.ai(model as Model<Api>));
		return new Proxy(provider, {
			get: (target, key) => {
				if (key === "id") return "openrouter";
				if (key === "name") return "OpenRouter (AI Gateway)";
				if (key === "getModels") return () => models;
				if (key === "getAllModels") return undefined;
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	#codemode: CodemodeRuntimeHandle | undefined;

	/** Cloudflare codemode over the desktop connector; scripts run in Dynamic Workers, completed calls replay. */
	get codemode(): CodemodeRuntimeHandle {
		this.#codemode ??= createCodemodeRuntime({
			ctx: this.ctx,
			executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
			connectors: [
				new DesktopConnector(this.ctx, this.env, async (op, args) => {
					const reply = await this.#call(crypto.randomUUID(), op, args);
					if (!reply.ok) throw new Error(reply.error);
					return reply.result;
				}),
			],
		});
		return this.#codemode;
	}

	#codemodeTool(): ToolRegistration {
		return {
			name: "codemode",
			description: "Run a JavaScript async function body in a sandbox with `desktop.read({ path })` and `desktop.bash({ command })` (both resolve to strings). Return the value you want back. Use it to batch several desktop operations in one step.",
			parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } as never,
			replay: "unsafe",
			execute: async (args) => {
				const output = await this.codemode.execute({ code: (args as { code: string }).code });
				return { content: [{ type: "text", text: JSON.stringify(output) }], isError: output.status === "error" };
			},
		};
	}

	#remoteTool(name: string, description: string, properties: Record<string, unknown>, replay: "safe" | "unsafe"): ToolRegistration {
		return {
			name,
			description,
			parameters: { type: "object", properties, required: Object.keys(properties) } as never,
			replay,
			execute: async (args, api) => {
				const reply = await this.#call(api.callId, name, args as Record<string, unknown>);
				return reply.ok ? { content: [{ type: "text", text: reply.result }] } : { content: [{ type: "text", text: reply.error }], isError: true };
			},
		};
	}

	/** Ask the connected runner to do something; "runner offline" when none is connected. */
	#call(id: string, op: string, args: Record<string, unknown>): Promise<RunnerReply> {
		const runner = this.ctx.getWebSockets(RUNNER_TAG)[0];
		if (runner === undefined) return Promise.resolve({ id, ok: false, error: "The desktop runner is offline." });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({ id, ok: false, error: `The runner did not answer ${op} within 120 s.` });
			}, 120_000);
			this.#pending.set(id, { resolve, timer });
			runner.send(JSON.stringify({ id, op, args }));
		});
	}

	/** RPC for the spike's HTTP API. */
	async ask(text: string): Promise<{ status: string; reason?: string; answer: string }> {
		const { status, reason, text: answer } = await this.harness.prompt(text);
		return { status, reason, answer: answer ?? "" };
	}

	/** Switch the root session's model: a Workers AI @cf/ id, or <provider>/<id> such as openrouter/deepseek/deepseek-v4.1-flash. */
	async setModel(spec: string): Promise<{ provider: string; id: string }> {
		const slash = spec.indexOf("/");
		const model = spec.startsWith("@cf/") || slash < 0 ? { provider: "cloudflare", id: spec } : { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
		await this.harness.session().setModel(model);
		return model;
	}

	async runCode(code: string): Promise<unknown> {
		return JSON.parse(JSON.stringify(await this.codemode.execute({ code })));
	}

	async submit(text: string): Promise<{ operationId: string }> {
		const { operationId } = await this.harness.submit(text);
		return { operationId };
	}

	async transcript(): Promise<unknown> {
		return { pending: await this.harness.pending(), messages: JSON.parse(JSON.stringify(await this.harness.messages())) };
	}

	async status(): Promise<{ runners: number }> {
		return { runners: this.ctx.getWebSockets(RUNNER_TAG).length };
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
		const brain = env.Brain.get(env.Brain.idFromName("saavy"));
		if (url.pathname === "/ws/runner") return brain.fetch(request);
		if (url.pathname === "/api/status") return Response.json(await brain.status());
		if (url.pathname === "/api/submit" && request.method === "POST") {
			const { text } = (await request.json()) as { text: string };
			return Response.json(await brain.submit(text));
		}
		if (url.pathname === "/api/model" && request.method === "POST") {
			const { model } = (await request.json()) as { model: string };
			return Response.json(await brain.setModel(model));
		}
		if (url.pathname === "/api/codemode" && request.method === "POST") {
			const { code } = (await request.json()) as { code: string };
			return Response.json(await brain.runCode(code));
		}
		if (url.pathname === "/api/transcript") return Response.json(await brain.transcript());
		if (url.pathname === "/api/prompt" && request.method === "POST") {
			const { text } = (await request.json()) as { text: string };
			return Response.json(await brain.ask(text));
		}
		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
