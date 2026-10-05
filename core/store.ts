// Where memory lives. The log, the tree, and the view's parts are kept in a store and read on demand, so memory holds
// only what a call needs: a history of a million messages costs the brain a few rows, not its 128 MB.

/** One log message (spec §2). */
export type Kind = "user" | "talk" | "tool" | "echo" | "note";

export interface Msg {
	/** Index in the log: the message's permanent id. */
	readonly i: number;
	readonly kind: Kind;
	readonly text: string;
	/** Bytes of `kind + ": " + text`. */
	readonly size: number;
	/** Milliseconds since the epoch. */
	readonly date: number;
	/** Where the message came from: `entryId:n` for the live conversation, `import:…` for imported history. */
	readonly key: string;
}

/** One tree node (spec §3): node (l, i) summarizes messages [i·2^l, (i+1)·2^l). */
export interface Node {
	readonly l: number;
	readonly i: number;
	readonly text: string;
	readonly size: number;
	/** Key of the node's last message. */
	readonly key: string;
}

export interface Part {
	readonly l: number;
	readonly i: number;
}

/** A message search candidate: holds every word, case-insensitively. */
export interface Hit {
	readonly i: number;
	readonly kind: Kind;
	readonly text: string;
}

/** Synchronous storage for one memory. Writes are durable when they return. */
export interface MemoryStore {
	logLength(): number;
	logGet(i: number): Msg | undefined;
	/** Append messages whose `i` continue the log. */
	logAppend(messages: readonly Msg[]): void;
	/** Messages holding every word (lowercase), newest first, at most `limit`. */
	logSearch(words: readonly string[], kind: string | undefined, limit: number): Hit[];
	/** Message dates from `since` (epoch ms) on. */
	logDates(since: number): number[];
	/** The highest live-conversation entry id already logged, to resume following the transcript. */
	lastEntry(): number;
	setLastEntry(id: number): void;

	treeGet(l: number, i: number): Node | undefined;
	treePut(node: Node): void;
	treeSize(): number;

	/** The view's parts as last saved, with the log length they cover. */
	viewLoad(): { parts: Part[]; covers: number } | undefined;
	viewSave(parts: readonly Part[], covers: number): void;
}

/** An in-memory store, for tests and short-lived local use. */
export class MemStore implements MemoryStore {
	readonly #log: Msg[] = [];
	readonly #tree = new Map<string, Node>();
	#view: { parts: Part[]; covers: number } | undefined;
	#last = 0;

	logLength(): number {
		return this.#log.length;
	}
	logGet(i: number): Msg | undefined {
		return this.#log[i];
	}
	logAppend(messages: readonly Msg[]): void {
		this.#log.push(...messages);
	}
	logSearch(words: readonly string[], kind: string | undefined, limit: number): Hit[] {
		const hits: Hit[] = [];
		for (let n = this.#log.length - 1; n >= 0 && hits.length < limit; n--) {
			const message = this.#log[n]!;
			if (kind !== undefined && message.kind !== kind) continue;
			const text = message.text.toLowerCase();
			if (words.every((word) => text.includes(word))) hits.push(message);
		}
		return hits;
	}
	logDates(since: number): number[] {
		return this.#log.filter((message) => message.date >= since).map((message) => message.date);
	}
	lastEntry(): number {
		return this.#last;
	}
	setLastEntry(id: number): void {
		this.#last = id;
	}
	treeGet(l: number, i: number): Node | undefined {
		return this.#tree.get(`${l}:${i}`);
	}
	treePut(node: Node): void {
		this.#tree.set(`${node.l}:${node.i}`, node);
	}
	treeSize(): number {
		return this.#tree.size;
	}
	viewLoad(): { parts: Part[]; covers: number } | undefined {
		return this.#view === undefined ? undefined : { parts: [...this.#view.parts], covers: this.#view.covers };
	}
	viewSave(parts: readonly Part[], covers: number): void {
		this.#view = { parts: [...parts], covers };
	}
}
