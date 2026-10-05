// Past sessions from other agents, as log messages (spec §2): user text, what the agent said, its tool calls, and their
// results (capped); thoughts, injected context, system prompts and compaction summaries stay out, as they do live.
// Main sessions only (a subagent's work reaches its parent as a tool result). Duplicates (forks, resumes, rewritten
// histories) are dropped by record id. Formats were mapped from the files on this machine; see import/README.md.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { bytes, cap, messagesOf } from "../core/log.ts";
import type { Kind } from "../core/store.ts";

export interface ImportMessage {
	readonly kind: Kind;
	readonly text: string;
	readonly date: number;
	/** Where it came from, for the log's key: `<source>:<session>:<record>`. */
	readonly key: string;
}

export interface ImportSession {
	readonly source: string;
	readonly id: string;
	readonly start: number;
	readonly cwd?: string;
	readonly title?: string;
	readonly messages: ImportMessage[];
}

export interface Skipped {
	reason: string;
	sessions: number;
	messages: number;
}

const HOME = homedir();

const toMs = (t: unknown): number | undefined => {
	if (typeof t === "number") return t < 1e11 ? t * 1000 : t;
	if (typeof t === "string") {
		const ms = Date.parse(t);
		return Number.isNaN(ms) ? undefined : ms;
	}
	return undefined;
};

/** Text of a content array (or string); images become [image]. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as { type?: string; text?: string }[]) {
		if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") parts.push(block.text ?? "");
		else if (block?.type === "image" || block?.type === "input_image" || block?.type === "image_url") parts.push("[image]");
	}
	return parts.join("\n");
}

class Builder {
	readonly messages: ImportMessage[] = [];
	readonly source: string;
	readonly id: string;
	constructor(source: string, id: string) {
		this.source = source;
		this.id = id;
	}
	add(kind: Kind, text: string, date: number | undefined, record: string): void {
		if (text.trim() === "" || date === undefined) return;
		this.messages.push({ kind, text: kind === "echo" ? cap(text) : text, date, key: `${this.source}:${this.id}:${record}` });
	}
	tool(name: string, args: unknown, date: number | undefined, record: string): void {
		this.add("tool", `${name} ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`, date, record);
	}
	session(extra: { cwd?: string; title?: string }): ImportSession | undefined {
		if (this.messages.length === 0) return undefined;
		return { source: this.source, id: this.id, start: this.messages[0]!.date, ...extra, messages: this.messages };
	}
}

const files = (dir: string, depth: number): string[] => {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (path: string, level: number) => {
		for (const name of readdirSync(path)) {
			const full = join(path, name);
			const stat = statSync(full);
			if (stat.isDirectory() && level < depth) walk(full, level + 1);
			else if (stat.isFile() && level === depth && name.endsWith(".jsonl")) out.push(full);
		}
	};
	walk(dir, 1);
	return out;
};

const jsonLines = (file: string): Record<string, unknown>[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.flatMap((line) => {
			if (line.trim() === "") return [];
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});

/** A copy of an SQLite file (and its WAL), so reading never touches the live database. */
function snapshot(path: string): DatabaseSync {
	const dir = mkdtempSync(join(tmpdir(), "saavy-import-"));
	const copy = join(dir, basename(path));
	copyFileSync(path, copy);
	for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
	return new DatabaseSync(copy);
}

// ─── pi and omp: pi's session format (a tree of entries; the active path is what happened) ───

function piSessions(source: string, dir: string, seen: Set<string>): ImportSession[] {
	const out: ImportSession[] = [];
	// Main sessions sit directly in a cwd folder; subagent transcripts are one level deeper.
	for (const file of files(dir, 2)) {
		const entries = jsonLines(file);
		const header = entries.find((entry) => entry.type === "session") as { id?: string; cwd?: string } | undefined;
		const title = (entries.findLast((entry) => entry.type === "title" || entry.type === "title_change") as { title?: string } | undefined)?.title;
		const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
		const onPath = new Set<string>();
		for (let at = entries.findLast((entry) => entry.type === "message" && typeof entry.id === "string"); at !== undefined; at = typeof at.parentId === "string" ? byId.get(at.parentId) : undefined) onPath.add(at.id as string);
		const session = new Builder(source, header?.id ?? basename(file, ".jsonl"));
		for (const entry of entries) {
			if (entry.type !== "message" || typeof entry.id !== "string" || !onPath.has(entry.id)) continue;
			const once = `${entry.id}|${String(entry.timestamp)}`;
			if (seen.has(once)) continue;
			seen.add(once);
			const message = entry.message as { role?: string; content?: unknown; synthetic?: boolean; attribution?: string; toolName?: string; isError?: boolean };
			const date = toMs(entry.timestamp);
			if (message.role === "user") {
				if (message.synthetic || (message.attribution !== undefined && message.attribution !== "user")) continue;
				session.add("user", textOf(message.content), date, entry.id);
			} else if (message.role === "assistant") {
				const blocks = Array.isArray(message.content) ? (message.content as { type: string; text?: string; name?: string; arguments?: unknown }[]) : [];
				blocks.forEach((block, n) => {
					if (block.type === "text") session.add("talk", block.text ?? "", date, `${entry.id}:${n}`);
					else if (block.type === "toolCall") session.tool(block.name ?? "tool", block.arguments, date, `${entry.id}:${n}`);
				});
			} else if (message.role === "toolResult") {
				const text = textOf(message.content);
				session.add("echo", message.isError ? `error: ${text}` : text, date, entry.id);
			}
		}
		const built = session.session({ ...(header?.cwd ? { cwd: header.cwd } : {}), ...(title ? { title } : {}) });
		if (built) out.push(built);
	}
	return out;
}

// ─── Claude Code ───

function claudeSessions(skipped: Skipped[]): ImportSession[] {
	const out: ImportSession[] = [];
	const seen = new Set<string>();
	const sdk: Skipped = { reason: "Claude SDK sessions", sessions: 0, messages: 0 };
	for (const file of files(join(HOME, ".claude", "projects"), 2)) {
		const records = jsonLines(file);
		const session = new Builder("claude", basename(file, ".jsonl"));
		let cwd: string | undefined;
		let title: string | undefined;
		let isSdk = false;
		for (const record of records) {
			if (record.type === "custom-title" || record.type === "ai-title") title = String(record.customTitle ?? record.aiTitle ?? record.title ?? title ?? "") || title;
			if (typeof record.uuid !== "string" || record.isSidechain === true) continue;
			if (seen.has(record.uuid)) continue;
			seen.add(record.uuid);
			if (/^sdk/.test(String(record.entrypoint ?? ""))) isSdk = true;
			cwd ??= typeof record.cwd === "string" ? record.cwd : undefined;
			const date = toMs(record.timestamp);
			const message = record.message as { content?: unknown } | undefined;
			if (record.type === "assistant" && Array.isArray(message?.content)) {
				(message.content as { type: string; text?: string; name?: string; input?: unknown }[]).forEach((block, n) => {
					if (block.type === "text") session.add("talk", block.text ?? "", date, `${record.uuid}:${n}`);
					else if (block.type === "tool_use" || block.type === "server_tool_use") session.tool(block.name ?? "tool", block.input, date, `${record.uuid}:${n}`);
				});
			} else if (record.type === "user") {
				const content = message?.content;
				if (Array.isArray(content) && content.some((block: { type?: string }) => block?.type === "tool_result")) {
					(content as { type: string; content?: unknown; is_error?: boolean }[]).forEach((block, n) => {
						if (block.type !== "tool_result") return;
						const text = textOf(block.content);
						session.add("echo", block.is_error ? `error: ${text}` : text, date, `${record.uuid}:${n}`);
					});
					continue;
				}
				const text = textOf(content).trim();
				const origin = (record.origin as { kind?: string } | undefined)?.kind;
				const injected =
					record.isCompactSummary === true ||
					record.isMeta === true ||
					record.promptSource === "system" ||
					(origin !== undefined && origin !== "human") ||
					/^<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|task-notification|wake |relay |ci-monitor-event|system-reminder)/.test(text) ||
					text.startsWith("[Request interrupted");
				if (!injected) session.add("user", text, date, record.uuid);
			} else if (record.type === "attachment") {
				const queued = record.attachment as { type?: string; prompt?: unknown; commandMode?: string; isMeta?: boolean; origin?: { kind?: string } } | undefined;
				if (queued?.type === "queued_command" && queued.commandMode === "prompt" && !queued.isMeta && (queued.origin?.kind ?? "human") === "human") session.add("user", textOf(queued.prompt), date, record.uuid);
			}
		}
		const built = session.session({ ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) });
		if (built === undefined) continue;
		if (isSdk) {
			sdk.sessions++;
			sdk.messages += built.messages.length;
		} else out.push(built);
	}
	skipped.push(sdk);
	return out;
}

// ─── Codex ───

function codexSessions(): ImportSession[] {
	const out: ImportSession[] = [];
	for (const file of files(join(HOME, ".codex", "sessions"), 4)) {
		let session = new Builder("codex", basename(file, ".jsonl"));
		let cwd: string | undefined;
		let n = 0;
		for (const record of jsonLines(file)) {
			const payload = (record.payload ?? {}) as Record<string, unknown>;
			const date = toMs(record.timestamp);
			const at = String(n++);
			if (record.type === "session_meta") {
				session = new Builder("codex", String(payload.id ?? session.id));
				cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
			} else if (record.type === "event_msg" && payload.type === "item_completed" && (payload.item as { type?: string })?.type === "UserMessage") {
				session.add("user", textOf((payload.item as { content?: unknown }).content), date, at);
			} else if (record.type === "response_item") {
				if (payload.type === "message" && payload.role === "assistant") session.add("talk", textOf(payload.content), date, at);
				else if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
					session.tool(`${payload.namespace ? `${String(payload.namespace)}.` : ""}${String(payload.name ?? payload.type)}`, payload.arguments ?? payload.input ?? payload.action, date, at);
				} else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
					const output = payload.output as unknown;
					session.add("echo", typeof output === "string" ? output : textOf(Array.isArray(output) ? output : (output as { content?: unknown })?.content), date, at);
				}
			}
		}
		const built = session.session(cwd ? { cwd } : {});
		if (built) out.push(built);
	}
	return out;
}

// ─── Hermes ───

function hermesSessions(skipped: Skipped[]): ImportSession[] {
	const out: ImportSession[] = [];
	const cron: Skipped = { reason: "Hermes cron runs", sessions: 0, messages: 0 };
	const stores = [
		["default", join(HOME, ".hermes", "state.db")],
		...["dev", "infra", "research"].map((profile) => [profile, join(HOME, ".hermes", "profiles", profile, "state.db")]),
	] as const;
	for (const [profile, path] of stores) {
		if (!existsSync(path)) continue;
		const db = snapshot(path);
		const sessions = db.prepare("SELECT id, source, parent_session_id, cwd, title FROM sessions").all() as { id: string; source: string | null; parent_session_id: string | null; cwd: string | null; title: string | null }[];
		const builders = new Map<string, { builder: Builder; meta: (typeof sessions)[number] }>();
		for (const meta of sessions) if (meta.parent_session_id === null) builders.set(meta.id, { builder: new Builder("hermes", `${profile}:${meta.id}`), meta });
		for (const row of db.prepare("SELECT id, session_id, role, content, tool_calls, timestamp, _compressed_summary AS summary, display_kind FROM messages ORDER BY id").iterate() as Iterable<Record<string, unknown>>) {
			const owner = builders.get(String(row.session_id));
			if (owner === undefined) continue;
			let text = typeof row.content === "string" ? row.content : "";
			if (text.startsWith("\u0000json:")) text = textOf(JSON.parse(text.slice(6)));
			const date = toMs(row.timestamp);
			const record = String(row.id);
			const summary = row.summary !== null && row.summary !== undefined && String(row.summary) !== "0";
			if (row.role === "user") {
				if (summary || text.startsWith("[CONTEXT COMPACTION") || row.display_kind || /^\[(IMPORTANT|ASYNC DELEGAT|System:|SYSTEM)/.test(text.trim())) continue;
				owner.builder.add("user", text, date, record);
			} else if (row.role === "assistant") {
				if (summary) continue;
				owner.builder.add("talk", text, date, record);
				let calls: { function?: { name?: string; arguments?: string }; name?: string }[] = [];
				try {
					calls = JSON.parse(String(row.tool_calls ?? "[]")) ?? [];
				} catch {}
				calls.forEach((call, n) => owner.builder.tool(call.function?.name ?? call.name ?? "tool", call.function?.arguments ?? "", date, `${record}:${n}`));
			} else if (row.role === "tool") owner.builder.add("echo", text, date, record);
		}
		for (const { builder, meta } of builders.values()) {
			const built = builder.session({ ...(meta.cwd ? { cwd: meta.cwd } : { cwd: `(hermes ${profile})` }), ...(meta.title ? { title: meta.title } : {}) });
			if (built === undefined) continue;
			if (meta.source === "cron") {
				cron.sessions++;
				cron.messages += built.messages.length;
			} else out.push(built);
		}
		db.close();
	}
	skipped.push(cron);
	return out;
}

// ─── the local saavy: pi-durable entries, one endless chat ───

function saavySessions(): ImportSession[] {
	const path = join(HOME, ".saavy", "session.sqlite");
	if (!existsSync(path)) return [];
	const db = snapshot(path);
	const session = new Builder("saavy", "local");
	for (const row of db.prepare("SELECT record FROM entries ORDER BY commit_seq, id").iterate() as Iterable<{ record: string }>) {
		const entry = JSON.parse(row.record) as EntryRecord;
		for (const message of messagesOf(entry)) session.messages.push({ kind: message.kind, text: message.text, date: message.date, key: `saavy:local:${message.key}` });
	}
	db.close();
	const built = session.session({ cwd: join(HOME, "dev", "saavy_agent"), title: "saavy (local)" });
	return built === undefined ? [] : [built];
}

/** Every source, filtered and sorted by when each session started. */
export function collect(): { sessions: ImportSession[]; skipped: Skipped[] } {
	const skipped: Skipped[] = [];
	const seen = new Set<string>();
	const all = [
		...piSessions("pi", join(HOME, ".pi", "agent", "sessions"), seen),
		...piSessions("omp", join(HOME, ".omp", "agent", "sessions"), seen),
		...claudeSessions(skipped),
		...codexSessions(),
		...hermesSessions(skipped),
		...saavySessions(),
	];
	const tmp: Skipped = { reason: "sessions run in /tmp", sessions: 0, messages: 0 };
	const kept = all.filter((session) => {
		if (session.cwd?.startsWith("/tmp")) {
			tmp.sessions++;
			tmp.messages += session.messages.length;
			return false;
		}
		return true;
	});
	skipped.push(tmp);
	kept.sort((a, b) => a.start - b.start);
	return { sessions: kept, skipped };
}

export const sizeOf = (message: ImportMessage): number => bytes(`${message.kind}: ${message.text}`);
