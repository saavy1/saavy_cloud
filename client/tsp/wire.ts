// Tern Surface Protocol framing (docs.stencil.so/tern/protocol): APC strings on the pty, JSON bodies, chunking.

import { appendFileSync } from "node:fs";

/** Program → terminal verbs. */
export type OutVerb = "q" | "o" | "f" | "b" | "t" | "s" | "x";

/** Largest body per message unless the hello reply says otherwise. */
export const DEFAULT_APC = 65_536;

const ESC = "\x1b";
const ST = `${ESC}\\`;
const PREFIX = `${ESC}_tsp;`;

let chunkCounter = 0;

/**
 * Encode one message. A body over `apc` bytes is split into chunks with the same verb, `c=<token>` on each and `m=1` on
 * all but the last. A split never leaves a chunk starting with a parameter-shaped segment: it only falls before a byte
 * outside [A-Za-z0-9_-].
 */
export function encode(verb: OutVerb, body: unknown, apc = DEFAULT_APC): Buffer {
	const bytes = Buffer.from(JSON.stringify(body), "utf8");
	if (bytes.length <= apc) return Buffer.concat([Buffer.from(`${PREFIX}${verb};`), bytes, Buffer.from(ST)]);
	const token = `k${(chunkCounter++).toString(36)}`;
	const chunks: Buffer[] = [];
	let start = 0;
	while (start < bytes.length) {
		let end = Math.min(start + apc, bytes.length);
		if (end < bytes.length) {
			// Back off until the next chunk starts with a safe byte.
			let safe = end;
			while (safe > start + 1 && /[A-Za-z0-9_-]/.test(String.fromCharCode(bytes[safe]!))) safe--;
			end = safe;
		}
		chunks.push(bytes.subarray(start, end));
		start = end;
	}
	// Raw bytes: a split may fall inside a UTF-8 character, which Tern joins back byte by byte.
	return Buffer.concat(
		chunks.flatMap((chunk, n) => [
			Buffer.from(`${PREFIX}${verb};c=${token};${n < chunks.length - 1 ? "m=1;" : ""}`),
			chunk,
			Buffer.from(ST),
		]),
	);
}

/** A terminal → program message: a reply (`r`) or an event (`e`). */
export interface Incoming {
	readonly verb: string;
	readonly body: Record<string, unknown>;
}

/** Parse one complete input sequence; undefined when it is not TSP. Accepts the ConPTY OSC 877 framing too. */
export function parseIncoming(sequence: string): Incoming | undefined {
	let rest: string | undefined;
	if (sequence.startsWith(PREFIX)) rest = sequence.slice(PREFIX.length);
	else if (sequence.startsWith(`${ESC}]877;tsp;`)) rest = sequence.slice(`${ESC}]877;tsp;`.length);
	if (rest === undefined) return undefined;
	rest = rest.replace(/(\x1b\\|\x07)$/, "");
	const semi = rest.indexOf(";");
	if (semi < 0) return undefined;
	try {
		return { verb: rest.slice(0, semi), body: JSON.parse(rest.slice(semi + 1)) as Record<string, unknown> };
	} catch {
		return undefined;
	}
}

/** Record every message as JSONL for Tern's `surface-play` (set SAAVY_TSP_RECORD=<file>). */
export class Recorder {
	readonly #path: string | undefined;
	readonly #start = Date.now();

	constructor(path = process.env.SAAVY_TSP_RECORD) {
		this.#path = path === "" ? undefined : path;
	}

	record(dir: "out" | "in", verb: string, body: unknown): void {
		if (this.#path === undefined) return;
		try {
			appendFileSync(this.#path, `${JSON.stringify({ t: Date.now() - this.#start, dir, verb, params: {}, body })}\n`);
		} catch {}
	}
}
