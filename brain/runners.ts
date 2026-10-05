// The brain's side of the runner link: one hibernatable WebSocket per connected desktop, calls matched to replies by
// id. Calls in flight live in memory; an eviction mid-call drops them and pi's replay rules decide what happens next.
import type { RunnerFrame, RunnerHello, WireResult } from "../core/protocol.ts";
import type { RunnerSend } from "./env.ts";

export const RUNNER_TAG = "runner";
/** Longest any one call may wait for its reply; exec has its own, shorter, timeout on the runner. */
const CALL_TIMEOUT_MS = 15 * 60_000;

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

	constructor(sockets: () => WebSocket[], onHello: (hello: RunnerHello) => void) {
		this.#sockets = sockets;
		this.#onHello = onHello;
	}

	get count(): number {
		return this.#sockets().length;
	}

	readonly send: RunnerSend = (call, onOutput, signal) => {
		// The newest connection wins: a restarted runner replaces a half-dead one.
		const socket = this.#sockets().at(-1);
		if (socket === undefined) return Promise.resolve(offline);
		const id = crypto.randomUUID();
		return new Promise((resolve) => {
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
		if ("hello" in frame) return this.#onHello(frame.hello);
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) return;
		if ("output" in frame) pending.onOutput?.(frame.output);
		else pending.resolve(frame.result);
	}
}
