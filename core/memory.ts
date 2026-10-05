// Memory: the log, the tree, the view, and the compactor that builds the tree (spec §4, §6, §7.1), over a store.

import type { Api, AssistantMessage, Message, Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { bytes, cutBytes, Log, type Msg } from "./log.ts";
import { COMPACT, SCALE } from "./prompts.ts";
import type { MemoryStore } from "./store.ts";
import { end, nodeId, start, Tree } from "./tree.ts";
import { View } from "./view.ts";

/** Target size of one summary line. */
export const NODE = 512;
/** Compactor calls at once. */
export const JOBS = 8;
/** Attempts per node to get under NODE. */
export const TRIES = 5;
/** Wait before retrying a failed node. */
export const RETRY_MS = 10_000;
/** Longest a compactor call may take: a stalled provider stream must not block every summary behind it. */
export const CALL_TIMEOUT_MS = 120_000;

export interface Compactor {
	readonly models: Models;
	/** Read at every call, so the compactor's model can change while it runs. */
	readonly current: () => { readonly model: Model<Api> | undefined; readonly thinking: ModelThinkingLevel | "off" };
	/**
	 * Build only inside drive(). On Workers, I/O belongs to the event that started it: a model call started from a
	 * commit listener dies, silently, when that event ends. The host drives memory from an event that awaits it.
	 */
	readonly driven?: boolean;
	/**
	 * Sent with every compactor call: providers route one session to one place, so its shared prefix stays cached
	 * (OpenCode requires it).
	 */
	readonly sessionId?: string;
	/** Compactor calls at once (default JOBS). */
	readonly jobs?: number;
	/**
	 * How far (in messages) nodes may start ahead of the first line still unsummarized. 0, the default, is the spec's
	 * order: each summary sees every one before it. A bulk import trades a little of that context for parallelism.
	 */
	readonly lookahead?: number;
}

export type MemoryEvent = { type: "built"; l: number; i: number } | { type: "failed"; l: number; i: number; error: Error };

const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

export { cutBytes };

/** Let a timer not hold a Node process open; workerd timers have no unref. */
const unref = (timer: unknown): void => (timer as { unref?: () => void }).unref?.();

export class Memory {
	readonly log: Log;
	readonly tree: Tree;
	readonly view: View;
	readonly #compactor: Compactor;
	readonly #busy = new Set<string>();
	readonly #failures = new Map<string, number>();
	readonly #waiters = new Set<() => void>();
	readonly #listeners = new Set<(event: MemoryEvent) => void>();
	#closed = false;
	/** True only while drive() itself is pumping: a driven memory starts builds from nowhere else. */
	#driving = false;

	/** The lowest index per level not known to be built: pump scans from here, not from 0. */
	readonly #frontier: number[] = [];

	constructor(store: MemoryStore, compactor: Compactor) {
		this.log = new Log(store);
		this.tree = new Tree(store);
		this.#compactor = compactor;
		this.view = new View(this.tree, this.log, store);
		this.log.subscribe((added) => {
			// One fit for a batch: an import adds many messages at once.
			for (const message of added) this.view.parts.push({ l: 0, i: message.i });
			this.#changed();
		});
	}

	subscribe(listener: (event: MemoryEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Compactor jobs running now. */
	get running(): number {
		return this.#busy.size;
	}

	close(): void {
		this.view.flush();
		this.#closed = true;
		for (const wake of this.#waiters) wake();
	}

	/**
	 * Resolve true once every line of the view is a summary (spec §6), false if `signal` aborts first, and "late" when
	 * `timeoutMs` passes first: a stuck compactor must not wedge the chat, so the caller may go on with placeholders.
	 */
	settle(signal?: AbortSignal, timeoutMs?: number): Promise<boolean | "late"> {
		return new Promise((resolve) => {
			const timer = timeoutMs === undefined ? undefined : setTimeout(() => done("late"), timeoutMs);
			const check = (): void => {
				if (signal?.aborted || this.#closed) return done(false);
				if (this.view.unbuilt() === 0) done(true);
			};
			const done = (value: boolean | "late"): void => {
				clearTimeout(timer);
				this.#waiters.delete(check);
				signal?.removeEventListener("abort", check);
				resolve(value);
			};
			this.#waiters.add(check);
			signal?.addEventListener("abort", check);
			check();
		});
	}

	/** zoom(id, n) (spec §7.1). */
	zoom(id: number, n: number): string {
		const T = this.log.length;
		const level = Math.log2(n);
		if (!Number.isInteger(id) || !Number.isInteger(level) || level < 0 || id % n !== 0 || id < 0 || id + n > T) {
			return `No line ${id}+${n}.`;
		}
		if (n === 1) {
			const message = this.log.at(id)!;
			return `${id}+0|${message.kind}: ${message.text}`;
		}
		const half = n / 2;
		const children = [0, 1].map((k) => {
			const i = (2 * id) / n + k;
			const node = this.tree.get(level - 1, i);
			return `${start(level - 1, i)}+${half}|${node === undefined ? "(not summarized yet: zoom it)" : flat(node.text)}`;
		});
		return children.join("\n");
	}

	/**
	 * search(query): messages whose text holds every word of `query` (case-insensitive), verbatim, so a fact the
	 * summaries dropped is still findable. Ranked by how often the words occur, newest first among equals; each hit is
	 * `id+0|kind: …snippet…`, ready for zoom(id, 1).
	 */
	search(query: string, options: { kind?: string; limit?: number } = {}): string {
		const words = query
			.toLowerCase()
			.split(/\s+/)
			.filter((word) => word !== "");
		if (words.length === 0) return "Give some words to search for.";
		const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
		const hits: { i: number; score: number; at: number }[] = [];
		// The store narrows to messages holding every word (newest first); ranking happens here.
		for (const message of this.log.store.logSearch(words, options.kind, 2000)) {
			const text = message.text.toLowerCase();
			let score = 0;
			let at = -1;
			for (const word of words) {
				const first = text.indexOf(word);
				if (first < 0) {
					score = 0;
					break;
				}
				if (at < 0) at = first;
				for (let from = first; from >= 0 && score < 1000; from = text.indexOf(word, from + word.length)) score++;
			}
			if (score > 0) hits.push({ i: message.i, score, at });
		}
		if (hits.length === 0) return `No message contains all of: ${words.join(" ")}.`;
		hits.sort((a, b) => b.score - a.score || b.i - a.i);
		const lines = hits.slice(0, limit).map(({ i, at }) => {
			const message = this.log.at(i)!;
			const start = Math.max(0, at - 80);
			const snippet = flat(message.text.slice(start, at + 160));
			return `${i}+0|${message.kind}: ${start > 0 ? "…" : ""}${snippet}${at + 160 < message.text.length ? "…" : ""}`;
		});
		const more = hits.length > limit ? `\n(${hits.length - limit} more; narrow the words or raise limit)` : "";
		return lines.join("\n") + more;
	}

	date(id: number): string {
		const message = Number.isInteger(id) ? this.log.at(id) : undefined;
		if (message === undefined) return `No message ${id}.`;
		const date = new Date(message.date);
		return `${date.toLocaleString("sv-SE", { timeZoneName: "short" })} (${date.toLocaleDateString("en-US", { weekday: "long" })})`;
	}

	/**
	 * Build what is ready, and keep building as nodes complete, until nothing is running. New builds start only for
	 * `budgetMs`; builds in flight then finish (each call has its own timeout).
	 */
	async drive(budgetMs: number): Promise<void> {
		const stopAt = Date.now() + budgetMs;
		for (;;) {
			if (this.#closed) return;
			if (Date.now() < stopAt) {
				this.#driving = true;
				try {
					this.pump();
				} finally {
					this.#driving = false;
				}
			}
			if (this.#busy.size === 0) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	/** Whether a node is ready to build now (or building). */
	get pending(): boolean {
		return this.#busy.size > 0 || this.view.unbuilt() > 0;
	}

	/** Start every node that is ready, in OptMem's order (spec §4.1). */
	pump(): void {
		if (this.#closed) return;
		if (this.#compactor.driven === true && !this.#driving) return;
		const T = this.log.length;
		const first = this.view.first();
		for (let l = 0; 2 ** l <= T; l++) {
			let f = this.#frontier[l] ?? 0;
			while (end(l, f) <= T && this.tree.has(l, f)) f++;
			this.#frontier[l] = f;
			for (let i = f; end(l, i) <= T; i++) {
				if (this.#busy.size >= (this.#compactor.jobs ?? JOBS)) return;
				const limit = l === 0 ? i : end(l, i);
				if (limit > first + (this.#compactor.lookahead ?? 0)) break;
				const id = nodeId(l, i);
				if (this.tree.has(l, i) || this.#busy.has(id)) continue;
				if (l > 0 && !(this.tree.has(l - 1, 2 * i) && this.tree.has(l - 1, 2 * i + 1))) continue;
				this.#busy.add(id);
				this.#build(l, i).then(
					() => {
						this.#busy.delete(id);
						this.#failures.delete(id);
						this.#emit({ type: "built", l, i });
						this.#changed();
					},
					(error: unknown) => {
						const count = (this.#failures.get(id) ?? 0) + 1;
						this.#failures.set(id, count);
						if (count === 1 || count % 6 === 0) {
							this.#emit({ type: "failed", l, i, error: error instanceof Error ? error : new Error(String(error)) });
						}
						unref(
							setTimeout(() => {
								this.#busy.delete(id);
								this.pump();
							}, RETRY_MS),
						);
					},
				);
			}
		}
	}

	#emit(event: MemoryEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	/** After a message or a node: refit, wake waiters, start what became ready. */
	#changed(): void {
		this.view.fit();
		for (const wake of [...this.#waiters]) wake();
		this.pump();
	}

	async #build(l: number, i: number): Promise<void> {
		const last = this.log.at(end(l, i) - 1) as Msg;
		const free = this.#free(l, i);
		if (free !== undefined) {
			this.tree.put({ l, i, text: free, size: bytes(free), key: last.key });
			return;
		}
		const { model, thinking } = this.#compactor.current();
		if (model === undefined) throw new Error("No compactor model available");
		const step =
			l === 0
				? `For scale, this ruler is exactly ${NODE} bytes (a length, not content):\n${SCALE}\n\nCompress this message into one line, in at most ${NODE} bytes:\n${this.log.at(i)!.kind}: ${this.log.at(i)!.text}`
				: `For scale, this ruler is exactly ${NODE} bytes (a length, not content):\n${SCALE}\n\nMerge these two lines into one, in at most ${NODE} bytes:\n${flat(this.tree.get(l - 1, 2 * i)!.text)}\n${flat(this.tree.get(l - 1, 2 * i + 1)!.text)}`;
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: this.view.context(l === 0 ? i : end(l, i)) },
					{ type: "text", text: step },
				],
				timestamp: Date.now(),
			},
		];
		const tries: string[] = [];
		for (;;) {
			const reply = await this.#ask(model, thinking, messages);
			const line = reply.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("")
				// The retry note marks where the limit falls; a model may echo the marker back.
				.replace(/\s*\|?\s*← LIMIT\s*/g, " ")
				.trim();
			if (line === "") throw new Error(`Empty summary for ${start(l, i)}+${2 ** l}`);
			tries.push(line);
			if (bytes(line) <= NODE || tries.length >= TRIES) break;
			messages.push(reply, {
				role: "user",
				content: `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cutBytes(line, NODE)}| ← LIMIT`,
				timestamp: Date.now(),
			});
		}
		// The shortest try, cut at the limit if no try fit: a node never takes more than its share of the view.
		const shortest = tries.reduce((best, line) => (bytes(line) < bytes(best) ? line : best));
		const text = bytes(shortest) <= NODE ? shortest : `${cutBytes(shortest, NODE - 3).trimEnd()}…`;
		this.tree.put({ l, i, text, size: bytes(text), key: last.key });
	}

	/** A node whose source already fits needs no model call (spec §3). */
	#free(l: number, i: number): string | undefined {
		if (l === 0) {
			const message = this.log.at(i)!;
			return message.size <= NODE ? `${message.kind}: ${message.text}` : undefined;
		}
		const joined = `${this.tree.get(l - 1, 2 * i)!.text}\n${this.tree.get(l - 1, 2 * i + 1)!.text}`;
		return bytes(joined) <= NODE ? joined : undefined;
	}

	async #ask(model: Model<Api>, thinking: ModelThinkingLevel | "off", messages: Message[]): Promise<AssistantMessage> {
		const { models } = this.#compactor;
		const context = normalizeContext({ systemPrompt: COMPACT, messages });
		const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
		const timedOut = new Error(`Compactor call timed out after ${CALL_TIMEOUT_MS / 1000}s`);
		// A hard deadline too: not every transport honors the signal, and a call that never settles would hold its
		// node (and whoever waits on the compactor) forever.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(timedOut), CALL_TIMEOUT_MS + 1000);
			unref(timer);
		});
		const { sessionId } = this.#compactor;
		const options = { signal, ...(thinking === "off" ? {} : { reasoning: thinking }), ...(sessionId === undefined ? {} : { sessionId }) };
		const call = models.streamSimple(model, context, options).result();
		const reply = await Promise.race([call, deadline]).finally(() => clearTimeout(timer));
		if (signal.aborted) throw timedOut;
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
		}
		return reply;
	}
}
