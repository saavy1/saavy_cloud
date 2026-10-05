// The tree (spec §3): node (l, i) summarizes messages [i·2^l, (i+1)·2^l). Nodes are stored once, never recomputed.

import type { MemoryStore, Node } from "./store.ts";

export type { Node } from "./store.ts";

export const nodeId = (l: number, i: number): string => `${l}:${i}`;
export const start = (l: number, i: number): number => i * 2 ** l;
export const end = (l: number, i: number): number => (i + 1) * 2 ** l;

export class Tree {
	readonly #store: MemoryStore;

	constructor(store: MemoryStore) {
		this.#store = store;
	}

	has(l: number, i: number): boolean {
		return this.#store.treeGet(l, i) !== undefined;
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
	}
}
