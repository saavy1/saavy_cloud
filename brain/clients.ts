// Front ends connected to the brain: one hibernatable WebSocket each. They call methods (RPC by id) and receive
// what changes: committed entries, pi's live docs, the phase, memory counters, notices.
import type { ClientFrame, ServerFrame } from "../core/protocol.ts";

export const CLIENT_TAG = "client";

export type ClientMethods = Record<string, (...args: never[]) => unknown>;

export class Clients {
	readonly #sockets: () => WebSocket[];
	readonly #methods: ClientMethods;

	constructor(sockets: () => WebSocket[], methods: ClientMethods) {
		this.#sockets = sockets;
		this.#methods = methods;
	}

	get count(): number {
		return this.#sockets().length;
	}

	broadcast(frame: ServerFrame): void {
		const sockets = this.#sockets();
		if (sockets.length === 0) return;
		const text = JSON.stringify(frame);
		for (const socket of sockets) {
			try {
				socket.send(text);
			} catch {
				// A socket closing mid-send drops out on its own.
			}
		}
	}

	/** One frame from a client: run the call and reply on that socket. */
	async receive(socket: WebSocket, message: string): Promise<void> {
		const frame = JSON.parse(message) as ClientFrame;
		if (frame?.t !== "call" || typeof frame.id !== "number") return;
		const method = this.#methods[frame.method];
		let reply: ServerFrame;
		if (method === undefined) reply = { t: "reply", id: frame.id, ok: false, error: `No method ${frame.method}` };
		else {
			try {
				const value = await (method as (...args: unknown[]) => unknown)(...(frame.args ?? []));
				reply = { t: "reply", id: frame.id, ok: true, value: value ?? null };
			} catch (error) {
				reply = { t: "reply", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		try {
			socket.send(JSON.stringify(reply));
		} catch {
			// The client left before its answer.
		}
	}
}
