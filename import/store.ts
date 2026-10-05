// The import's memory, in a local SQLite file with the brain's schema: built here (resumable: stop and rerun at any
// time, finished nodes stay), then uploaded to the brain.
import { DatabaseSync } from "node:sqlite";
import type { Hit, Kind, MemoryStore, Msg, Node, Part } from "../core/store.ts";

export class NodeSqliteStore implements MemoryStore {
	readonly db: DatabaseSync;
	#length: number;
	#treeSize: number;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS saavy_log (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, date INTEGER NOT NULL, key TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS saavy_tree (l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (l, i));
			CREATE TABLE IF NOT EXISTS saavy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS saavy_log_date ON saavy_log (date);
		`);
		this.#length = Number((this.db.prepare("SELECT COALESCE(MAX(i) + 1, 0) AS n FROM saavy_log").get() as { n: number }).n);
		this.#treeSize = Number((this.db.prepare("SELECT COUNT(*) AS n FROM saavy_tree").get() as { n: number }).n);
	}

	meta(k: string): string | undefined {
		return (this.db.prepare("SELECT v FROM saavy_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
	}

	setMeta(k: string, v: string): void {
		this.db.prepare("INSERT INTO saavy_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v);
	}

	logLength(): number {
		return this.#length;
	}

	logGet(i: number): Msg | undefined {
		const row = this.db.prepare("SELECT i, kind, text, size, date, key FROM saavy_log WHERE i = ?").get(i) as Record<string, unknown> | undefined;
		return row === undefined ? undefined : { i: Number(row.i), kind: String(row.kind) as Kind, text: String(row.text), size: Number(row.size), date: Number(row.date), key: String(row.key) };
	}

	logAppend(messages: readonly Msg[]): void {
		const insert = this.db.prepare("INSERT INTO saavy_log (i, kind, text, size, date, key) VALUES (?, ?, ?, ?, ?, ?)");
		this.db.exec("BEGIN");
		try {
			for (const m of messages) insert.run(m.i, m.kind, m.text, m.size, m.date, m.key);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.#length += messages.length;
	}

	logSearch(words: readonly string[], kind: string | undefined, limit: number): Hit[] {
		const where = words.map(() => "instr(lower(text), ?) > 0");
		const bindings: (string | number)[] = [...words];
		if (kind !== undefined) {
			where.push("kind = ?");
			bindings.push(kind);
		}
		bindings.push(limit);
		return (this.db.prepare(`SELECT i, kind, text FROM saavy_log WHERE ${where.join(" AND ")} ORDER BY i DESC LIMIT ?`).all(...bindings) as Record<string, unknown>[]).map((row) => ({
			i: Number(row.i),
			kind: String(row.kind) as Kind,
			text: String(row.text),
		}));
	}

	logDates(since: number): number[] {
		return (this.db.prepare("SELECT date FROM saavy_log WHERE date >= ? ORDER BY i").all(since) as { date: number }[]).map((row) => Number(row.date));
	}

	lastEntry(): number {
		return Number(this.meta("last_entry") ?? 0);
	}

	setLastEntry(id: number): void {
		this.setMeta("last_entry", String(id));
	}

	treeGet(l: number, i: number): Node | undefined {
		const row = this.db.prepare("SELECT l, i, text, size, key FROM saavy_tree WHERE l = ? AND i = ?").get(l, i) as Record<string, unknown> | undefined;
		return row === undefined ? undefined : { l: Number(row.l), i: Number(row.i), text: String(row.text), size: Number(row.size), key: String(row.key) };
	}

	treePut(node: Node): void {
		if (this.treeGet(node.l, node.i) !== undefined) return;
		this.db.prepare("INSERT INTO saavy_tree (l, i, text, size, key) VALUES (?, ?, ?, ?, ?)").run(node.l, node.i, node.text, node.size, node.key);
		this.#treeSize++;
	}

	treeSize(): number {
		return this.#treeSize;
	}

	viewLoad(): { parts: Part[]; covers: number } | undefined {
		const saved = this.meta("view");
		return saved === undefined ? undefined : (JSON.parse(saved) as { parts: Part[]; covers: number });
	}

	viewSave(parts: readonly Part[], covers: number): void {
		this.setMeta("view", JSON.stringify({ parts, covers }));
	}
}
