// One inline TSP surface: handshake, frames under flow control, events, and a clean close.
// Patterns after oh-my-pi's native backend (MIT, github.com/can1357/oh-my-pi): credits with a stall fallback, ops on
// evicted ids filtered out, settle for retention.

import { StdinBuffer } from "@earendil-works/pi-tui";
import { DEFAULT_APC, encode, type Incoming, type OutVerb, parseIncoming, Recorder } from "./wire.ts";

/** A TSP op, as a JSON array. */
export type Op = readonly unknown[];

export interface Hello {
	readonly kinds: readonly string[];
	readonly features: readonly string[];
	readonly apc: number;
	readonly credits: number;
	readonly cols: number;
	readonly dark: boolean;
	readonly reduceMotion: boolean;
}

/** Whether to try TSP at all: inside Tern, outside multiplexers (they swallow APC), unless turned off. */
export function tspWanted(env = process.env): boolean {
	if (env.SAAVY_TSP === "0") return false;
	if (env.SAAVY_TSP === "1") return true;
	if (env.TMUX !== undefined || env.STY !== undefined || env.ZELLIJ !== undefined) return false;
	return env.TERM_PROGRAM === "tern" && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export interface Handshake {
	readonly hello: Hello | undefined;
	/** The terminal answered the kitty keyboard query. */
	readonly kitty: boolean;
}

/**
 * Ask for TSP (and the kitty keyboard protocol) and wait for the answers. A TSP terminal replies to the hello before
 * DA1; DA1 alone, or nothing within `timeoutMs`, means no TSP. Leaves stdin raw and paused.
 */
export async function handshake(features: readonly string[], timeoutMs = 1000): Promise<Handshake> {
	const stdin = process.stdin;
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	const buffer = new StdinBuffer({ timeout: 50 });
	let kitty = false;
	let hello: Hello | undefined;
	const result = await new Promise<Hello | undefined>((resolve) => {
		const timer = setTimeout(() => done(), timeoutMs);
		// The answers can arrive in separate reads; DA1 always comes last, so wait for it (or the timeout) before
		// deciding, or a kitty reply after the hello is missed and Shift+Enter arrives as a plain Enter.
		const done = () => {
			clearTimeout(timer);
			stdin.off("data", onData);
			resolve(hello);
		};
		buffer.on("data", (sequence) => {
			const message = parseIncoming(sequence);
			if (message?.verb === "r" && message.body.r === "hello") {
				const body = message.body;
				hello = {
					kinds: (body.kinds as string[] | undefined) ?? [],
					features: (body.features as string[] | undefined) ?? [],
					apc: (body.apc as number | undefined) ?? DEFAULT_APC,
					credits: (body.credits as number | undefined) ?? 2,
					cols: (body.cols as number | undefined) ?? process.stdout.columns ?? 80,
					dark: (body.dark as boolean | undefined) ?? true,
					reduceMotion: (body.reduceMotion as boolean | undefined) ?? false,
				};
				return;
			}
			if (/^\x1b\[\?\d+u$/.test(sequence)) kitty = true;
			// DA1 comes last: no hello before it means no TSP.
			else if (/^\x1b\[\?[\d;]*c$/.test(sequence)) done();
		});
		const onData = (data: string) => buffer.process(data);
		stdin.on("data", onData);
		stdin.resume();
		const query = encode("q", { q: "hello", v: [1], app: "saavy", ver: "0.1.0", features });
		process.stdout.write(Buffer.concat([query, Buffer.from("\x1b[?u\x1b[c")]));
	});
	buffer.destroy();
	stdin.pause();
	return { hello: result, kitty };
}

export interface SurfaceEvents {
	/** An event from the terminal (ack and gone are handled here, then passed on too). */
	event(body: Record<string, unknown>): void;
	/** A key or paste sequence that is not TSP. */
	key(sequence: string): void;
	paste(text: string): void;
}

const STALLED_ACK_MS = 5000;

export class Surface {
	readonly id = "s1";
	readonly hello: Hello;
	readonly #recorder = new Recorder();
	readonly #buffer = new StdinBuffer({ timeout: 50 });
	readonly #gone = new Set<string>();
	#pending: Op[] = [];
	#unacked: { s: number; at: number }[] = [];
	#seq = 0;
	#scheduled = false;
	#closed = false;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#onData = (data: string) => this.#buffer.process(data);

	constructor(hello: Hello, handlers: SurfaceEvents) {
		this.hello = hello;
		this.#buffer.on("data", (sequence) => {
			const message = parseIncoming(sequence);
			if (message === undefined) return handlers.key(sequence);
			this.#recorder.record("in", message.verb, message.body);
			if (message.verb === "e") {
				this.#handle(message);
				handlers.event(message.body);
			}
		});
		this.#buffer.on("paste", (text) => handlers.paste(text));
	}

	#write(verb: OutVerb, body: unknown): void {
		this.#recorder.record("out", verb, body);
		process.stdout.write(encode(verb, body, this.hello.apc));
	}

	/** Open the surface with its three regions, and start reading input. */
	open(regions: { main: object; dock: object; layer: object }, css?: string): void {
		// Bracketed paste so a paste is one event, not keys.
		process.stdout.write("\x1b[?2004h");
		this.#write("o", { id: this.id, mode: "inline", title: "saavy", role: "saavy.session" });
		process.stdout.write("\x1b]0;saavy\x07");
		if (css !== undefined && this.hello.features.includes("styles")) this.#write("s", { sf: this.id, name: "saavy", css });
		this.#pending.push(
			["add", "main", this.id, null, regions.main],
			["add", "dock", this.id, null, regions.dock],
			["add", "layer", this.id, null, regions.layer],
		);
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", this.#onData);
		process.stdin.resume();
		this.#flush();
	}

	isGone(id: string): boolean {
		return this.#gone.has(id);
	}

	/** Queue ops; they go out as one frame when credit allows. */
	op(...ops: Op[]): void {
		if (this.#closed) return;
		for (const op of ops) this.#pending.push(op);
		if (this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			this.#flush();
		});
	}

	/** Send queued ops now, ignoring credit (for suspend/resume around a child program). */
	now(...ops: Op[]): void {
		for (const op of ops) this.#pending.push(op);
		this.#flush(true);
	}

	#flush(force = false): void {
		if (this.#pending.length === 0) return;
		const oldest = this.#unacked[0];
		// A terminal that stops acking (or a detached session) must not freeze us forever.
		if (oldest !== undefined && Date.now() - oldest.at > STALLED_ACK_MS) this.#unacked = [];
		if (!force && this.#unacked.length >= this.hello.credits) {
			// Try again once the oldest frame counts as stalled, in case no ack and no new op ever comes.
			if (this.#retry === undefined) {
				const wait = Math.max(0, STALLED_ACK_MS - (Date.now() - this.#unacked[0]!.at)) + 10;
				this.#retry = setTimeout(() => {
					this.#retry = undefined;
					this.#flush();
				}, wait);
				this.#retry.unref();
			}
			return;
		}
		const ops = merge(this.#pending.filter((op) => !this.#touchesGone(op)));
		this.#pending = [];
		if (ops.length === 0) return;
		const s = ++this.#seq;
		this.#unacked.push({ s, at: Date.now() });
		this.#write("f", { sf: this.id, s, ops });
	}

	#touchesGone(op: Op): boolean {
		const name = op[0];
		if (name === "add") return this.#gone.has(op[2] as string);
		if (name === "focus" || name === "suspend" || name === "resume") return false;
		return typeof op[1] === "string" && this.#gone.has(op[1]);
	}

	#handle(message: Incoming): void {
		const body = message.body;
		if (body.ev === "ack" && typeof body.s === "number") {
			this.#unacked = this.#unacked.filter((frame) => frame.s > (body.s as number));
			this.#flush();
		} else if (body.ev === "gone" && Array.isArray(body.ids)) {
			for (const id of body.ids as string[]) this.#gone.add(id);
		}
	}

	/** Close (the transcript stays until the next prompt), then drain input so no event reaches the shell. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#flush(true);
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#write("x", { id: this.id, keep: true });
		process.stdout.write("\x1b[?2004l\x1b[<u");
		await new Promise((resolve) => setTimeout(resolve, 100));
		process.stdin.off("data", this.#onData);
		this.#buffer.destroy();
		process.stdin.setRawMode(false);
		process.stdin.pause();
	}
}

/**
 * Collapse a frame's ops while keeping their effect: appends to one text node join, a replace drops the earlier text
 * ops on its node, and sets on one node merge. A search back stops at anything that adds, deletes, or moves that node.
 */
export function merge(ops: Op[]): Op[] {
	const out: (Op | undefined)[] = [];
	const structural = (op: Op, id: unknown) =>
		(op[0] === "add" || op[0] === "del" || op[0] === "move") && (op[1] === id || op[2] === id);
	for (const op of ops) {
		const id = op[1];
		if (op[0] === "text" || op[0] === "set") {
			let merged = false;
			for (let i = out.length - 1; i >= 0; i--) {
				const prior = out[i];
				if (prior === undefined) continue;
				if (structural(prior, id) || prior[0] === "settle" || prior[0] === "suspend" || prior[0] === "resume") break;
				if (prior[1] !== id) continue;
				if (op[0] === "text" && prior[0] === "text") {
					if (op[2] === "replace") {
						// Take the earlier op's place, so a later caret set still follows the text it refers to.
						out[i] = op;
						merged = true;
					}
					else if (prior[2] === "append" || prior[2] === "replace") {
						out[i] = ["text", id, prior[2], (prior[3] as string) + (op[3] as string)];
						merged = true;
					}
					break;
				}
				if (op[0] === "set" && prior[0] === "set") {
					out[i] = ["set", id, { ...(prior[2] as object), ...(op[2] as object) }];
					merged = true;
					break;
				}
			}
			if (merged) continue;
		}
		out.push(op);
	}
	return out.filter((op): op is Op => op !== undefined);
}
