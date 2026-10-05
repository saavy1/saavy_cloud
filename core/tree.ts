// The tree (spec §3): node (l, i) summarizes messages [i·2^l, (i+1)·2^l). Nodes are stored once, never recomputed.

import type { MemoryStore, Node } from "./store.ts";

export type { Node } from "./store.ts";

export const nodeId = (l: number, i: number): string => `${l}:${i}`;
export const start = (l: number, i: number): number => i * 2 ** l;
export const end = (l: number, i: number): number => (i + 1) * 2 ** l;

/** Presence answers kept in memory: the view asks about every line on every change. Flags only, no texts. */
const PRESENCE_CAP = 500_000;

export class Tree {
	readonly #store: MemoryStore;
	/** Whether a node exists, for nodes asked about; exact, because nodes only appear through put(). */
	readonly #present = new Map<string, boolean>();

	constructor(store: MemoryStore) {
		this.#store = store;
	}

	has(l: number, i: number): boolean {
		const key = nodeId(l, i);
		let present = this.#present.get(key);
		if (present === undefined) {
			if (this.#present.size >= PRESENCE_CAP) this.#present.clear();
			present = this.#store.treeGet(l, i) !== undefined;
			this.#present.set(key, present);
		}
		return present;
	}

	get(l: number, i: number): Node | undefined {
		return this.#store.treeGet(l, i);
	}

	get size(): number {
		return this.#store.treeSize();
	}

	/** Store a node durably, then make it visible. */
	put(node: Node): void {
		this.#store.treePut(node);
		this.#present.set(nodeId(node.l, node.i), true);
	}
}
