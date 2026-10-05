// The brain's side of the runner link: one hibernatable WebSocket per connected desktop, calls matched to replies by
// id. Calls in flight live in memory; after an eviction pi replays the tool, its keyed calls reach the runner again
// (waiting for it to redial), and the runner answers them with the results it kept.
import type { RunnerFrame, RunnerHello, WireResult } from "../core/protocol.ts";
import type { RunnerSend } from "./env.ts";

export const RUNNER_TAG = "runner";
/** Longest any one call may wait for its reply; exec has its own, shorter, timeout on the runner. */
const CALL_TIMEOUT_MS = 15 * 60_000;
/**
 * How long a call waits for a runner to (re)connect. A runner redials within seconds of a drop, and a call replayed
 * right after an eviction must reach it to collect its result.
 */
const CONNECT_WAIT_MS = 30_000;

const offline: WireResult = { ok: false, error: { kind: "file", code: "unknown", message: "The desktop runner is offline: the user's machine is not connected right now." } };

interface Pending {
	readonly resolve: (result: WireResult) => void;
	readonly onOutput: ((text: string) => void) | undefined;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class Runners {
	readonly #sockets: () => WebSocket[];
	readonly #onHello: (hello: RunnerHello) => void;
	readonly #pending = new Map<string, Pending>();
	readonly #waiting = new Set<() => void>();

	constructor(sockets: () => WebSocket[], onHello: (hello: RunnerHello) => void) {
		this.#sockets = sockets;
		this.#onHello = onHello;
	}

	get count(): number {
		return this.#sockets().length;
	}

	/** A runner connected: calls waiting for one go ahead. */
	connected(): void {
		for (const wake of [...this.#waiting]) wake();
	}

	/** The newest runner socket (a restarted runner replaces a half-dead one), waiting a little for one to connect. */
	async #socket(signal: AbortSignal | undefined): Promise<WebSocket | undefined> {
		const now = this.#sockets().at(-1);
		if (now !== undefined) return now;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.#waiting.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, CONNECT_WAIT_MS);
			this.#waiting.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
		return this.#sockets().at(-1);
	}

	readonly send: RunnerSend = async (call, onOutput, signal) => {
		const socket = await this.#socket(signal);
		if (socket === undefined) return offline;
		const id = crypto.randomUUID();
		return new Promise<WireResult>((resolve) => {
			const finish = (result: WireResult) => {
				const pending = this.#pending.get(id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.#pending.delete(id);
				signal?.removeEventListener("abort", cancel);
				resolve(result);
			};
			const cancel = () => {
				socket.send(JSON.stringify({ id, op: "cancel" }));
				finish({ ok: false, error: { kind: call.method === "exec" ? "exec" : "file", code: "aborted", message: "Aborted." } });
			};
			const timer = setTimeout(() => finish({ ok: false, error: { kind: "file", code: "unknown", message: `The runner did not answer ${call.method} in time.` } }), CALL_TIMEOUT_MS);
			this.#pending.set(id, { resolve: finish, onOutput, timer });
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				socket.send(JSON.stringify({ id, op: "env", ...call }));
			} catch {
				finish(offline);
			}
		});
	};

	/** A frame from a runner socket. */
	receive(message: string): void {
		const frame = JSON.parse(message) as RunnerFrame;
		if ("hello" in frame) {
			this.#onHello(frame.hello);
			this.connected();
			return;
		}
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) return;
		if ("output" in frame) pending.onOutput?.(frame.output);
		else pending.resolve(frame.result);
	}
}
