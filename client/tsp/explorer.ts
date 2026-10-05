// The memory explorer: Tern's picker in its tree layout over the summary tree. The view's lines are the top level;
// each opens into the two lines it was made from, down to the messages. The preview pane shows the whole summary or
// message with its range, time span, and size. Keys and clicks are saavy's to handle (Tern's pickers are
// program-driven); rows and the preview are sent as props and children. The memory lives in the brain: what a step
// shows is fetched first (the view's lines, a line's children, the messages at the ends of each span), then drawn.

import { matchesKey } from "@earendil-works/pi-tui";
import type { RemoteMemory } from "../remote.ts";
import type { Op } from "./surface.ts";

interface Item {
	readonly id: string;
	readonly depth: number;
	/** Node coordinates, or a message index for a leaf. */
	readonly l?: number;
	readonly i: number;
	readonly leaf: boolean;
}

const flat = (text: string) => text.replace(/\s*\n\s*/g, " ");
const bytes = (text: string) => new TextEncoder().encode(text).length;
const when = (ms: number) => new Date(ms).toLocaleString("sv-SE").slice(0, 16);

export class MemoryExplorer {
	readonly id: string;
	readonly #memory: RemoteMemory;
	readonly #T: number;
	readonly #op: (...ops: Op[]) => void;
	readonly #onClose: () => void;
	readonly #items = new Map<string, Item>();
	readonly #open = new Set<string>();
	#order: string[] = [];
	#selected: string | undefined;
	#preview = 0;

	/** Fetch the view's lines and open the explorer over them. */
	static async open(id: string, memory: RemoteMemory, op: (...ops: Op[]) => void, onClose: () => void): Promise<MemoryExplorer> {
		const parts = await memory.parts();
		const explorer = new MemoryExplorer(id, memory, op, onClose, parts);
		await explorer.#load([...explorer.#items.values()]);
		explorer.#draw();
		return explorer;
	}

	private constructor(id: string, memory: RemoteMemory, op: (...ops: Op[]) => void, onClose: () => void, parts: { l: number; i: number }[]) {
		this.id = id;
		this.#memory = memory;
		this.#op = op;
		this.#onClose = onClose;
		this.#T = memory.stats.messages;
		for (const part of parts) this.#remember({ id: `${part.l}:${part.i}`, depth: 0, l: part.l, i: part.i, leaf: false });
		this.#order = parts.map((part) => `${part.l}:${part.i}`);
		this.#selected = this.#order.at(-1);
	}

	/** Fetch what drawing `items` needs: their summaries, and the messages at the ends of their spans. */
	#load(items: readonly Item[]): Promise<void> {
		const nodes = items.filter((item) => !item.leaf).map((item) => ({ l: item.l!, i: item.i }));
		const msgs = items.flatMap((item) => this.#span(item));
		return this.#memory.load(nodes, msgs);
	}

	#draw(): void {
		const id = this.id;
		const op = this.#op;
		const T = this.#T;
		op([
			"add",
			id,
			"layer",
			null,
			{
				id,
				k: "picker",
				p: {
					size: "screen",
					layout: "tree",
					preview: "side",
					title: "Memory",
					subtitle: `${T} messages · ${this.#memory.stats.summaries} summaries · the view's ${this.#order.length} lines`,
					icon: "tree",
					noun: "line",
					columns: [
						{ id: "n", head: "msgs" },
						{ id: "when", head: "when" },
					],
					items: this.#rows(),
					order: this.#order,
					...(this.#selected === undefined ? {} : { selected: this.#selected }),
					actions: [
						{ id: "toggle", label: "Open / close", keys: ["enter"], primary: true },
						{ id: "close", label: "Close", keys: ["escape"], end: true },
					],
				},
				c: [],
			},
		]);
		this.#showPreview();
	}

	#remember(item: Item): void {
		this.#items.set(item.id, item);
	}

	#span(item: Item): [number, number] {
		if (item.leaf || item.l === undefined) return [item.i, item.i];
		return [item.i * 2 ** item.l, Math.min(this.#T, (item.i + 1) * 2 ** item.l) - 1];
	}

	#text(item: Item): string | undefined {
		if (item.leaf) {
			const message = this.#memory.msg(item.i);
			return message === undefined ? undefined : `${message.kind}: ${message.text}`;
		}
		return this.#memory.node(item.l!, item.i);
	}

	#row(item: Item): Record<string, unknown> {
		const [a, b] = this.#span(item);
		const text = this.#text(item);
		const label = text === undefined ? "(not summarized yet)" : flat(text).slice(0, 160);
		return {
			id: item.id,
			label,
			detail: item.leaf ? `#${item.i}` : `${a}+${b - a + 1}`,
			depth: item.depth,
			...(item.leaf ? {} : { open: this.#open.has(item.id) }),
			...(item.leaf ? { icon: "message" } : {}),
			facts: { n: b - a + 1, when: when(this.#memory.msg(b)?.date ?? 0) },
			...(text === undefined ? { tone: "muted" } : {}),
		};
	}

	#rows(): Record<string, unknown>[] {
		return [...this.#items.values()].map((item) => this.#row(item));
	}

	#children(item: Item): Item[] {
		if (item.leaf) return [];
		const depth = item.depth + 1;
		if (item.l === 0) return [{ id: `m:${item.i}`, depth, i: item.i, leaf: true }];
		const l = item.l! - 1;
		return [2 * item.i, 2 * item.i + 1]
			.filter((i) => i * 2 ** l < this.#T)
			.map((i) => ({ id: `${l}:${i}`, depth, l, i, leaf: false }));
	}

	/** Open or close a line; opening fetches its children and adds them right below it. */
	async #toggle(id: string): Promise<void> {
		const item = this.#items.get(id);
		if (item === undefined || item.leaf) return;
		const at = this.#order.indexOf(id);
		if (this.#open.has(id)) {
			this.#open.delete(id);
			// Drop every visible descendant.
			let end = at + 1;
			while (end < this.#order.length && this.#items.get(this.#order[end]!)!.depth > item.depth) {
				this.#open.delete(this.#order[end]!);
				end++;
			}
			this.#order.splice(at + 1, end - at - 1);
		} else {
			this.#open.add(id);
			const children = this.#children(item);
			await this.#load(children);
			for (const child of children) this.#remember(child);
			this.#order.splice(at + 1, 0, ...children.map((child) => child.id));
		}
		this.#op(["set", this.id, { items: this.#rows(), order: this.#order, selected: this.#selected ?? null }]);
	}

	#select(id: string | undefined): void {
		if (id === undefined || id === this.#selected) return;
		this.#selected = id;
		this.#op(["set", this.id, { selected: id }]);
		this.#showPreview();
	}

	#showPreview(): void {
		const item = this.#selected === undefined ? undefined : this.#items.get(this.#selected);
		const old = `${this.id}.pv${this.#preview}`;
		const next = `${this.id}.pv${++this.#preview}`;
		const ops: Op[] = this.#preview > 1 ? [["del", old]] : [];
		if (item !== undefined) {
			const [a, b] = this.#span(item);
			const text = this.#text(item);
			const first = this.#memory.msg(a);
			const last = this.#memory.msg(b);
			const items = [
				{ k: item.leaf ? "message" : "covers", v: item.leaf ? `#${item.i} (${first?.kind})` : `messages ${a}–${b} (${b - a + 1})` },
				{ k: "when", v: first === undefined ? "" : a === b ? when(first.date) : `${when(first.date)} → ${when(last!.date)}` },
				{ k: "size", v: text === undefined ? "not summarized yet" : `${bytes(text)} B${item.leaf ? "" : " (summary)"}` },
				...(item.leaf || item.l === undefined ? [] : [{ k: "zoom", v: `zoom(${a}, ${2 ** item.l})` }]),
			];
			const body = text === undefined
				? { id: `${next}.t`, k: "text", p: { text: "This stretch has not been summarized yet.", tone: "muted" } }
				: item.leaf
					? { id: `${next}.t`, k: "code", p: { lang: "text", text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text, wrap: true } }
					: { id: `${next}.t`, k: "md", p: { text } };
			ops.push(["add", next, this.id, null, { id: next, k: "col", p: { gap: "sm" }, c: [{ id: `${next}.kv`, k: "kv", p: { items } }, body] }]);
		}
		this.#op(...ops);
	}

	#parent(id: string): string | undefined {
		const at = this.#order.indexOf(id);
		const depth = this.#items.get(id)?.depth ?? 0;
		for (let n = at - 1; n >= 0; n--) if (this.#items.get(this.#order[n]!)!.depth < depth) return this.#order[n];
		return undefined;
	}

	key(data: string): void {
		const id = this.#selected;
		const at = id === undefined ? -1 : this.#order.indexOf(id);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.close();
		if (matchesKey(data, "up")) return this.#select(this.#order[Math.max(0, at - 1)]);
		if (matchesKey(data, "down")) return this.#select(this.#order[Math.min(this.#order.length - 1, at + 1)]);
		if (matchesKey(data, "pageUp")) return this.#select(this.#order[Math.max(0, at - 15)]);
		if (matchesKey(data, "pageDown")) return this.#select(this.#order[Math.min(this.#order.length - 1, at + 15)]);
		if (matchesKey(data, "home")) return this.#select(this.#order[0]);
		if (matchesKey(data, "end")) return this.#select(this.#order.at(-1));
		if (id === undefined) return;
		if (matchesKey(data, "right") || matchesKey(data, "enter") || data === " ") {
			if (!this.#open.has(id)) void this.#toggle(id);
			else if (matchesKey(data, "right")) this.#select(this.#order[at + 1]);
			else void this.#toggle(id);
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#open.has(id)) void this.#toggle(id);
			else this.#select(this.#parent(id));
		}
	}

	event(body: Record<string, unknown>): void {
		if (body.ev === "select" && typeof body.item === "string") this.#select(body.item);
		else if (body.ev === "activate" && typeof body.item === "string") {
			this.#select(body.item);
			void this.#toggle(body.item);
		} else if (body.ev === "action") {
			if (body.act === "toggle" && this.#selected !== undefined) void this.#toggle(this.#selected);
			else this.close();
		}
	}

	close(): void {
		this.#op(["del", this.id]);
		this.#onClose();
	}
}
