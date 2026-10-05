// Agent UI in Tern: a spec (core/ui.ts) as wire nodes, every id namespaced so agent UI never collides with saavy's
// own nodes.
import type { UiNode } from "../../core/ui.ts";

/** A drawn UI: its wire tree and the map between the agent's ids and wire ids. */
export interface WireUi {
	readonly node: Record<string, unknown>;
	readonly wire: Map<string, string>;
	readonly agent: Map<string, string>;
}

/**
 * The spec as wire nodes under `prefix`: every node gets an id (the agent's own, else its path), namespaced; a
 * table's or list's `selected` and a card's head child keep pointing at the renamed ids.
 */
export function toWire(spec: UiNode, prefix: string): WireUi {
	const wire = new Map<string, string>();
	const agent = new Map<string, string>();
	const convert = (node: UiNode, path: string): Record<string, unknown> => {
		const local = node.id ?? path;
		const id = `${prefix}.${local}`;
		wire.set(local, id);
		agent.set(id, local);
		const children = (node.c ?? []).map((child, n) => convert(child, `${path}-${n}`));
		return { id, k: node.k, ...(node.p === undefined ? {} : { p: { ...node.p } }), ...(children.length === 0 ? {} : { c: children }) };
	};
	const node = convert(spec, "n");
	// Props that name other nodes by id follow the renaming.
	const fix = (wireNode: Record<string, unknown>): void => {
		const p = wireNode.p as Record<string, unknown> | undefined;
		if (p !== undefined && typeof p.selected === "string" && wire.has(p.selected)) p.selected = wire.get(p.selected);
		for (const child of (wireNode.c as Record<string, unknown>[] | undefined) ?? []) fix(child);
	};
	fix(node);
	return { node, wire, agent };
}
