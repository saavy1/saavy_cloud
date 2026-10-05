// The view (spec §5): tree nodes tiling the whole chat, oldest first, under a byte budget. It only ever appends at
// the end and merges the most due pair; it never splits, so its start stays stable from one call to the next.
// Its parts are saved with every change, so a brain that wakes does not refold the chat from message 0.

import { bytes, type Log } from "./log.ts";
import { PLACEHOLDER } from "./prompts.ts";
import type { MemoryStore, Part } from "./store.ts";
import { end, start, type Tree } from "./tree.ts";

export type { Part } from "./store.ts";

/** Byte budget of the view (≈ 62-64k tokens). */
export const VIEW = 128_000;

const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

export class View {
	parts: Part[] = [];
	readonly #tree: Tree;
	readonly #log: Log;
	readonly #store: MemoryStore;
	readonly #budget: number;
	/** Texts of built parts; nodes never change, so they are cached for good. */
	readonly #texts = new Map<string, string>();

	constructor(tree: Tree, log: Log, store: MemoryStore, budget = VIEW) {
		this.#tree = tree;
		this.#log = log;
		this.#store = store;
		this.#budget = budget;
		// Resume from the saved parts, then fold in what was logged since (spec §5.2: same result as from 0).
		const saved = store.viewLoad();
		let from = 0;
		if (saved !== undefined && saved.covers <= log.length) {
			this.parts = saved.parts;
			from = saved.covers;
		}
		for (let i = from; i < log.length; i++) this.parts.push({ l: 0, i });
		this.fit();
	}

	built(part: Part): boolean {
		return this.#text(part) !== undefined;
	}

	#text(part: Part): string | undefined {
		const key = `${part.l}:${part.i}`;
		let text = this.#texts.get(key);
		if (text === undefined) {
			text = this.#tree.get(part.l, part.i)?.text;
			if (text !== undefined) this.#texts.set(key, text);
		}
		return text;
	}

	text(part: Part): string {
		return this.#text(part) ?? PLACEHOLDER;
	}

	/** The view for a new message `i`. */
	append(i: number): void {
		this.parts.push({ l: 0, i });
		this.fit();
	}

	/** Merge the most due pairs, while over budget and while their parents are built; then save. */
	fit(): void {
		const T = this.#log.length;
		let size = 0;
		for (const part of this.parts) size += bytes(this.text(part));
		while (size > this.#budget) {
			let best = -1;
			let bestDue = -Infinity;
			for (let n = 0; n + 1 < this.parts.length; n++) {
				const a = this.parts[n]!;
				const b = this.parts[n + 1]!;
				if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !this.#tree.has(a.l + 1, a.i / 2)) continue;
				// OptMem's age rule: age over weight, so detail fades with age and each level keeps about as many lines.
				const due = (T - start(a.l, a.i)) / 2 ** (a.l + 2);
				if (due > bestDue) {
					best = n;
					bestDue = due;
				}
			}
			if (best < 0) break;
			const a = this.parts[best]!;
			const b = this.parts[best + 1]!;
			const parent = { l: a.l + 1, i: a.i / 2 };
			size += bytes(this.text(parent)) - bytes(this.text(a)) - bytes(this.text(b));
			this.parts.splice(best, 2, parent);
			this.#texts.delete(`${a.l}:${a.i}`);
			this.#texts.delete(`${b.l}:${b.i}`);
		}
		const last = this.parts.at(-1);
		this.#store.viewSave(this.parts, last === undefined ? 0 : end(last.l, last.i));
	}

	/** The first message whose view line is not summarized yet; the log length when every line is. */
	first(): number {
		for (const part of this.parts) if (!this.built(part)) return start(part.l, part.i);
		return this.#log.length;
	}

	unbuilt(): number {
		return this.parts.filter((part) => !this.built(part)).length;
	}

	/** Bytes of the rendered lines. */
	size(): number {
		let size = 0;
		for (const part of this.parts) size += bytes(this.text(part));
		return size;
	}

	/** `id+n|text` per part, inside <chat> tags: what every agent call sees. */
	render(): string {
		const lines = this.parts.map((part) => `${start(part.l, part.i)}+${2 ** part.l}|${flat(this.text(part))}`);
		return `<chat>\n${lines.map((line) => `${line}\n`).join("")}</chat>`;
	}

	/**
	 * The compactor's context: bare lines (no ids, spec §4.2) of the parts that end at or before `limit`. For a merge,
	 * `limit` is the node's end; for a level-0 node, its own index.
	 */
	context(limit: number): string {
		const lines = this.parts.filter((part) => end(part.l, part.i) <= limit).map((part) => flat(this.text(part)));
		return `<chat>\n${lines.map((line) => `${line}\n`).join("")}</chat>`;
	}
}
