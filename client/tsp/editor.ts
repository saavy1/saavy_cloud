// The composer under TSP: the program owns the text and caret, Tern draws them (`editor` node, docked). With the
// `edit` feature Tern keeps its own selection, soft-wrap navigation, and clicks, and sends them as `edit` events.

import { type AutocompleteItem, type AutocompleteProvider, decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";
import type { Op } from "./surface.ts";

export interface EditorHandlers {
	submit(text: string): void;
	/** Ops to send for the editor and its completion popup. */
	ops(ops: Op[]): void;
}

const WORD = /[\p{L}\p{N}_]/u;

export class EditorModel {
	readonly id: string;
	text = "";
	cursor = 0;
	readonly #handlers: EditorHandlers;
	readonly #history: string[] = [];
	#historyIndex = -1;
	#draft = "";
	#provider: AutocompleteProvider | undefined;
	#suggestions: { items: AutocompleteItem[]; prefix: string } | undefined;
	#selected = 0;
	#abort: AbortController | undefined;
	#shownPopup = false;

	constructor(id: string, handlers: EditorHandlers) {
		this.id = id;
		this.#handlers = handlers;
	}

	setProvider(provider: AutocompleteProvider): void {
		this.#provider = provider;
	}

	addToHistory(text: string): void {
		if (text !== "" && this.#history.at(-1) !== text) this.#history.push(text);
	}

	/** The editor node, for the first frame. */
	node(placeholder: string): object {
		return {
			id: this.id,
			k: "editor",
			p: { text: this.text, cursor: this.cursor, placeholder, maxLines: 8 },
		};
	}

	/** The completion popup's container, which lives in `layer`. */
	popupNode(): object {
		return { id: `${this.id}.ac`, k: "overlay", p: { anchor: { caret: this.id }, hidden: true }, c: [] };
	}

	#set(text: string, cursor: number, complete = true): void {
		this.text = text;
		this.cursor = Math.max(0, Math.min(cursor, text.length));
		this.#handlers.ops([
			["text", this.id, "replace", this.text],
			["set", this.id, { cursor: this.cursor, anchor: null }],
		]);
		if (complete) void this.#complete(false);
	}

	insert(text: string): void {
		this.#set(this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor), this.cursor + text.length);
	}

	clear(): void {
		this.#historyIndex = -1;
		this.#set("", 0);
	}

	/** Apply a native edit from Tern; a stale one (keys in flight) is ignored. */
	applyEdit(edit: { from: number; to: number; text: string; cursor: number; len: number }): void {
		if (edit.len !== this.text.length) return;
		const text = this.text.slice(0, edit.from) + edit.text + this.text.slice(edit.to);
		this.text = text;
		this.cursor = Math.max(0, Math.min(edit.cursor, text.length));
		// Tern already shows the edit; only the caret needs confirming.
		this.#handlers.ops([["set", this.id, { cursor: this.cursor }]]);
		void this.#complete(false);
	}

	/** Handle a key; false when the editor does not use it. */
	handleKey(data: string): boolean {
		const popup = this.#suggestions !== undefined && this.#suggestions.items.length > 0;
		if (popup && (matchesKey(data, "up") || matchesKey(data, "down"))) {
			const n = this.#suggestions!.items.length;
			this.#selected = (this.#selected + (matchesKey(data, "up") ? n - 1 : 1)) % n;
			this.#handlers.ops([["set", `${this.id}.acl`, { selected: `${this.id}.ac.${this.#selected}` }]]);
			return true;
		}
		if (popup && (matchesKey(data, "tab") || matchesKey(data, "enter"))) {
			const item = this.#suggestions!.items[this.#selected]!;
			// Enter on what is already typed (the completion would only add a space) submits it.
			const typed = matchesKey(data, "enter") && this.#completed(item).trimEnd() === this.text.trimEnd();
			if (!typed) {
				this.#applyCompletion(item);
				return true;
			}
		}
		if (popup && matchesKey(data, "escape")) {
			this.#hidePopup();
			return true;
		}
		if (matchesKey(data, "enter")) {
			const text = this.text;
			this.#hidePopup();
			this.#handlers.submit(text);
			return true;
		}
		if (matchesKey(data, "shift+enter") || matchesKey(data, "alt+enter") || matchesKey(data, "ctrl+j")) {
			this.insert("\n");
			return true;
		}
		if (matchesKey(data, "tab")) {
			void this.#complete(true);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) this.#set(this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor), this.cursor - 1);
			return true;
		}
		if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
			if (this.cursor < this.text.length) this.#set(this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1), this.cursor);
			return this.text !== "" || !matchesKey(data, "ctrl+d");
		}
		if (matchesKey(data, "left")) return this.#move(this.cursor - 1);
		if (matchesKey(data, "right")) return this.#move(this.cursor + 1);
		if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left")) return this.#move(this.#wordStart());
		if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right")) return this.#move(this.#wordEnd());
		if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) return this.#move(this.text.lastIndexOf("\n", this.cursor - 1) + 1);
		if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
			const end = this.text.indexOf("\n", this.cursor);
			return this.#move(end < 0 ? this.text.length : end);
		}
		if (matchesKey(data, "ctrl+u")) {
			const start = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
			this.#set(this.text.slice(0, start) + this.text.slice(this.cursor), start);
			return true;
		}
		if (matchesKey(data, "ctrl+k")) {
			const end = this.text.indexOf("\n", this.cursor);
			this.#set(this.text.slice(0, this.cursor) + this.text.slice(end < 0 ? this.text.length : end), this.cursor);
			return true;
		}
		if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
			const start = this.#wordStart();
			this.#set(this.text.slice(0, start) + this.text.slice(this.cursor), start);
			return true;
		}
		// Up on the first line and down on the last walk the history (inside wrapped text Tern moves the caret).
		if (matchesKey(data, "up") && !this.text.slice(0, this.cursor).includes("\n")) return this.#historyStep(-1);
		if (matchesKey(data, "down") && !this.text.slice(this.cursor).includes("\n")) return this.#historyStep(1);
		const printable = decodeKittyPrintable(data) ?? (/^[^\x00-\x1f\x7f]+$/.test(data) ? data : undefined);
		if (printable !== undefined) {
			this.insert(printable);
			return true;
		}
		return false;
	}

	#move(cursor: number): boolean {
		this.cursor = Math.max(0, Math.min(cursor, this.text.length));
		this.#handlers.ops([["set", this.id, { cursor: this.cursor, anchor: null }]]);
		return true;
	}

	#wordStart(): number {
		let i = this.cursor;
		while (i > 0 && !WORD.test(this.text[i - 1]!)) i--;
		while (i > 0 && WORD.test(this.text[i - 1]!)) i--;
		return i;
	}

	#wordEnd(): number {
		let i = this.cursor;
		while (i < this.text.length && !WORD.test(this.text[i]!)) i++;
		while (i < this.text.length && WORD.test(this.text[i]!)) i++;
		return i;
	}

	#historyStep(direction: -1 | 1): boolean {
		if (this.#history.length === 0) return true;
		if (this.#historyIndex === -1) {
			if (direction === 1) return true;
			this.#draft = this.text;
			this.#historyIndex = this.#history.length - 1;
		} else {
			this.#historyIndex += direction;
			if (this.#historyIndex >= this.#history.length) {
				this.#historyIndex = -1;
				this.#set(this.#draft, this.#draft.length, false);
				return true;
			}
			this.#historyIndex = Math.max(0, this.#historyIndex);
		}
		const text = this.#history[this.#historyIndex]!;
		this.#set(text, text.length, false);
		return true;
	}

	// ─── Completion ───

	#position(): { lines: string[]; line: number; col: number } {
		const before = this.text.slice(0, this.cursor).split("\n");
		return { lines: this.text.split("\n"), line: before.length - 1, col: before.at(-1)!.length };
	}

	/** Slash commands complete as you type; Tab forces file paths. */
	async #complete(force: boolean): Promise<void> {
		this.#abort?.abort();
		if (this.#provider === undefined || (!force && !this.text.startsWith("/"))) return this.#hidePopup();
		const abort = new AbortController();
		this.#abort = abort;
		const { lines, line, col } = this.#position();
		let suggestions: { items: AutocompleteItem[]; prefix: string } | null = null;
		try {
			suggestions = await this.#provider.getSuggestions(lines, line, col, { signal: abort.signal, force });
		} catch {}
		if (abort.signal.aborted) return;
		if (suggestions === null || suggestions.items.length === 0) return this.#hidePopup();
		// Tab with a single match applies it at once.
		if (force && suggestions.items.length === 1) {
			this.#suggestions = suggestions;
			this.#applyCompletion(suggestions.items[0]!);
			return;
		}
		this.#suggestions = { items: suggestions.items.slice(0, 50), prefix: suggestions.prefix };
		this.#selected = 0;
		this.#renderPopup();
	}

	#completed(item: AutocompleteItem): string {
		const { lines, line, col } = this.#position();
		return this.#provider!.applyCompletion(lines, line, col, item, this.#suggestions?.prefix ?? "").lines.join("\n");
	}

	/** Apply a completion; false when it changes nothing. */
	#applyCompletion(item: AutocompleteItem): boolean {
		const prefix = this.#suggestions?.prefix ?? "";
		const { lines, line, col } = this.#position();
		const result = this.#provider!.applyCompletion(lines, line, col, item, prefix);
		const text = result.lines.join("\n");
		const cursor = result.lines.slice(0, result.cursorLine).reduce((sum, l) => sum + l.length + 1, 0) + result.cursorCol;
		this.#hidePopup();
		if (text === this.text) return false;
		this.#set(text, cursor);
		return true;
	}

	#renderPopup(): void {
		const suggestions = this.#suggestions!;
		const items = suggestions.items.map((item, n) => ({
			id: `${this.id}.ac.${n}`,
			k: "item",
			p: { label: item.label, ...(item.description === undefined ? {} : { detail: item.description }), value: item.value },
		}));
		const list = { id: `${this.id}.acl`, k: "list", p: { selected: `${this.id}.ac.${this.#selected}`, max: { h: "10lines" } }, c: items };
		this.#handlers.ops([
			...(this.#shownPopup ? [["del", `${this.id}.acl`] as Op] : []),
			["add", `${this.id}.acl`, `${this.id}.ac`, null, list],
			["set", `${this.id}.ac`, { hidden: false }],
		]);
		this.#shownPopup = true;
	}

	#hidePopup(): void {
		this.#suggestions = undefined;
		if (!this.#shownPopup) return;
		this.#shownPopup = false;
		this.#handlers.ops([
			["del", `${this.id}.acl`],
			["set", `${this.id}.ac`, { hidden: true }],
		]);
	}

	/** A click on a popup row. */
	pick(itemId: string): boolean {
		const n = Number(itemId.slice(`${this.id}.ac.`.length));
		const item = this.#suggestions?.items[n];
		if (item === undefined) return false;
		this.#applyCompletion(item);
		return true;
	}
}
