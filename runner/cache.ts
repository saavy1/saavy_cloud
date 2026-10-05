// Results of keyed desktop calls, so a call the brain repeats after an eviction gets the first result instead of
// running twice. A result keeps the output its call streamed (a shell's stdout and stderr): the repeat is answered with
// that output, then the result. Kept for an hour, in memory and in a 0600 JSON-lines file (over 1 MB: memory only).
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { WireResult } from "../core/protocol.ts";

const TTL_MS = 60 * 60_000;
const MAX_PERSISTED = 1024 * 1024;

export interface Outcome {
	readonly result: WireResult;
	/** What the call streamed while it ran. */
	readonly output: string;
}

export class ResultCache {
	readonly #path: string | undefined;
	readonly #done = new Map<string, { at: number; outcome: Outcome }>();
	readonly #running = new Map<string, Promise<Outcome>>();

	constructor(path?: string) {
		this.#path = path;
		if (path === undefined || !existsSync(path)) return;
		const now = Date.now();
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line === "") continue;
			try {
				const entry = JSON.parse(line) as { key: string; at: number; outcome: Outcome };
				if (now - entry.at < TTL_MS && entry.outcome !== undefined) this.#done.set(entry.key, { at: entry.at, outcome: entry.outcome });
			} catch {
				// A torn last line from a crash.
			}
		}
		// Rewrite without what expired.
		writeFileSync(path, [...this.#done].map(([key, { at, outcome }]) => `${JSON.stringify({ key, at, outcome })}\n`).join(""), { mode: 0o600 });
		chmodSync(path, 0o600);
	}

	/**
	 * The first outcome for `key`: the saved one, the one in flight, or `run()`'s; `fresh` says whether this caller ran
	 * it (and so saw its output stream live). Aborted runs are not kept.
	 */
	async run(key: string, run: () => Promise<Outcome>): Promise<{ outcome: Outcome; fresh: boolean }> {
		const done = this.#done.get(key);
		if (done !== undefined && Date.now() - done.at < TTL_MS) return { outcome: done.outcome, fresh: false };
		const running = this.#running.get(key);
		if (running !== undefined) return { outcome: await running, fresh: false };
		const promise = run().then((outcome) => {
			this.#running.delete(key);
			if (!outcome.result.ok && outcome.result.error.code === "aborted") return outcome;
			const at = Date.now();
			this.#done.set(key, { at, outcome });
			const line = `${JSON.stringify({ key, at, outcome })}\n`;
			if (this.#path !== undefined && line.length <= MAX_PERSISTED) {
				try {
					appendFileSync(this.#path, line, { mode: 0o600 });
				} catch {
					// Memory still has it.
				}
			}
			for (const [old, entry] of this.#done) if (at - entry.at >= TTL_MS) this.#done.delete(old);
			return outcome;
		});
		this.#running.set(key, promise);
		return { outcome: await promise, fresh: true };
	}
}
