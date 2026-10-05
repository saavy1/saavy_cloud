// The desktop runner: dials out to the brain and serves pi's ExecutionEnv on this machine, so the agent's file and
// shell tools act here while its memory and loop live on Cloudflare. Reconnects whenever the socket drops.
//
//   SAAVY_URL=wss://…/ws/runner SAAVY_TOKEN=… node runner/runner.ts
import { homedir, hostname, platform } from "node:os";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type BrainFrame, decodeValue, ENV_METHODS, encodeValue, type RunnerFrame, type WireResult } from "../core/protocol.ts";

const url = `${process.env.SAAVY_URL}?token=${encodeURIComponent(process.env.SAAVY_TOKEN ?? "")}`;
const RECONNECT_MS = 2000;

/** One env per working directory, as the local agent keeps them. */
const envs = new Map<string, NodeExecutionEnv>();
const envFor = (cwd: string): NodeExecutionEnv => {
	let env = envs.get(cwd);
	if (env === undefined) envs.set(cwd, (env = new NodeExecutionEnv({ cwd })));
	return env;
};

function toWire(result: { ok: boolean; value?: unknown; error?: unknown }): WireResult {
	if (result.ok) return { ok: true, value: encodeValue(result.value) };
	const error = result.error as { name?: string; code?: string; message?: string; path?: string };
	return {
		ok: false,
		error: {
			kind: error?.name === "ExecutionError" ? "exec" : "file",
			code: error?.code ?? "unknown",
			message: error?.message ?? String(result.error),
			...(error?.path === undefined ? {} : { path: error.path }),
		},
	};
}

function connect(): void {
	const socket = new WebSocket(url);
	const running = new Map<string, AbortController>();
	const send = (frame: RunnerFrame) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
	};

	socket.addEventListener("open", () => {
		console.log("runner connected");
		send({ hello: { host: hostname(), platform: platform(), home: homedir() } });
	});
	socket.addEventListener("message", async (event) => {
		const frame = JSON.parse(String(event.data)) as BrainFrame;
		if (typeof frame?.id !== "string") return;
		if (frame.op === "cancel") {
			running.get(frame.id)?.abort();
			return;
		}
		if (frame.op !== "env" || !(ENV_METHODS as readonly string[]).includes(frame.method)) {
			send({ id: frame.id, result: { ok: false, error: { kind: "file", code: "not_supported", message: `runner cannot ${String((frame as { method?: unknown }).method)}` } } });
			return;
		}
		const abort = new AbortController();
		running.set(frame.id, abort);
		const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
		const env = envFor(frame.cwd) as ExecutionEnv;
		const args = frame.args.map(decodeValue);
		console.log(`${frame.method} ${JSON.stringify(args[0]).slice(0, 160)}`);
		try {
			if (frame.method === "exec") {
				const options = { ...(args[1] as object), onOutput: (text: string) => send({ id: frame.id, output: text }) };
				send({ id: frame.id, result: toWire(await env.exec(args[0] as string, options, context)) });
			} else {
				const method = env[frame.method] as (...rest: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
				send({ id: frame.id, result: toWire(await method.call(env, ...args, context)) });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			send({ id: frame.id, result: { ok: false, error: { kind: frame.method === "exec" ? "exec" : "file", code: "unknown", message } } });
		} finally {
			running.delete(frame.id);
		}
	});
	socket.addEventListener("close", () => {
		for (const abort of running.values()) abort.abort();
		console.log(`runner disconnected; retrying in ${RECONNECT_MS / 1000} s`);
		setTimeout(connect, RECONNECT_MS);
	});
	socket.addEventListener("error", () => {});
}

connect();
