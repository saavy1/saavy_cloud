// The log (spec §2): every message of the chat, derived from durable's transcript (and, later, imported history).
// Entries are immutable and append-only, so the derivation is stable: the same entries always give the same messages.

import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Kind, MemoryStore, Msg } from "./store.ts";

export type { Kind, Msg } from "./store.ts";

/** Max characters of one tool result (head and tail kept). */
export const CAP = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bytes = (text: string): number => encoder.encode(text).length;

/** `text` cut to its first `limit` bytes, without splitting a UTF-8 character. */
export function cutBytes(text: string, limit: number): string {
	return decoder.decode(encoder.encode(text).subarray(0, limit)).replace(/�$/, "");
}

/** The head and tail of `text`, with a note of what was cut, when it exceeds CAP characters. */
export function cap(text: string): string {
	if (text.length <= CAP) return text;
	const half = CAP / 2;
	return `${text.slice(0, half)}\n[... ${text.length - CAP} characters cut ...]\n${text.slice(-half)}`;
}

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
		.filter((text) => text !== "")
		.join("\n");
}

/** The log messages one transcript entry contributes, without ids. Thoughts are never logged (spec §2). */
export function messagesOf(entry: EntryRecord): Omit<Msg, "i">[] {
	const out: Omit<Msg, "i">[] = [];
	const push = (kind: Kind, text: string, date: number): void => {
		if (text.trim() === "") return;
		out.push({ kind, text, size: bytes(`${kind}: ${text}`), date, key: `${entry.id}:${out.length}` });
	};
	for (const message of entry.model ?? []) {
		if (entry.kind === "pi.user" && message.role === "user") {
			push("user", textOf(message.content), message.timestamp);
		} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
			// Failed attempts are retried; only what the agent actually said and did is history.
			if (message.stopReason === "error") continue;
			let talk = "";
			for (const block of message.content) {
				if (block.type === "text") talk += block.text;
				else if (block.type === "toolCall") {
					push("talk", talk.trim(), message.timestamp);
					talk = "";
					push("tool", `${block.name} ${JSON.stringify(block.arguments)}`, message.timestamp);
				}
			}
			push("talk", talk.trim(), message.timestamp);
		} else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
			const text = cap(textOf(message.content));
			push("echo", message.isError ? `error: ${text}` : text, message.timestamp);
		}
	}
	return out;
}

/** The whole log, read through the store and kept live as entries commit. */
export class Log {
	readonly store: MemoryStore;
	readonly #listeners = new Set<(added: readonly Msg[]) => void>();

	constructor(store: MemoryStore) {
		this.store = store;
	}

	get length(): number {
		return this.store.logLength();
	}

	at(i: number): Msg | undefined {
		return this.store.logGet(i);
	}

	/** Append the messages of a committed entry, once: entries at or below the last one logged are skipped. */
	add(entry: EntryRecord): Msg[] {
		const id = Number(entry.id);
		if (Number.isFinite(id) && id <= this.store.lastEntry()) return [];
		return this.append(messagesOf(entry), Number.isFinite(id) ? id : undefined);
	}

	/** Append messages (from an entry, or imported); returns them with their ids. */
	append(messages: readonly Omit<Msg, "i">[], entry?: number): Msg[] {
		const base = this.length;
		const added = messages.map((message, n) => ({ ...message, i: base + n }));
		if (added.length > 0) this.store.logAppend(added);
		if (entry !== undefined) this.store.setLastEntry(entry);
		if (added.length > 0) for (const listener of this.#listeners) listener(added);
		return added;
	}

	subscribe(listener: (added: readonly Msg[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
