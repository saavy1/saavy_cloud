// Memory in the Durable Object's SQLite, next to pi's own tables (ours are prefixed saavy_).
import type { Hit, Kind, MemoryStore, Msg, Node, Part } from "../core/store.ts";

export class SqlMemoryStore implements MemoryStore {
	readonly #storage: DurableObjectStorage;
	readonly #sql: SqlStorage;
	#length: number;
	#treeSize: number;

	constructor(storage: DurableObjectStorage) {
		this.#storage = storage;
		this.#sql = storage.sql;
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS saavy_log (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, date INTEGER NOT NULL, key TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS saavy_tree (l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (l, i));
			CREATE TABLE IF NOT EXISTS saavy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS saavy_log_date ON saavy_log (date);
		`);
		this.#length = Number(this.#sql.exec("SELECT COALESCE(MAX(i) + 1, 0) AS n FROM saavy_log").one().n);
		this.#treeSize = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM saavy_tree").one().n);
	}

	/** The home directory the runner reported, the default working directory. */
	runnerHome(): string | undefined {
		return this.#meta("runner_home");
	}

	setRunnerHome(home: string): void {
		if (this.#meta("runner_home") !== home) this.#setMeta("runner_home", home);
	}

	/** The user's instructions as last read on the desktop, for when it is offline. */
	readonly instructions = {
		get: (): string | undefined => this.#meta("instructions"),
		set: (text: string): void => this.#setMeta("instructions", text),
	};

	#meta(k: string): string | undefined {
		const rows = this.#sql.exec("SELECT v FROM saavy_meta WHERE k = ?", k).toArray();
		return rows.length === 0 ? undefined : String(rows[0]!.v);
	}

	#setMeta(k: string, v: string): void {
		this.#sql.exec("INSERT INTO saavy_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
	}

	logLength(): number {
		return this.#length;
	}

	logGet(i: number): Msg | undefined {
		const rows = this.#sql.exec("SELECT i, kind, text, size, date, key FROM saavy_log WHERE i = ?", i).toArray();
		return rows.length === 0 ? undefined : toMsg(rows[0]!);
	}

	logAppend(messages: readonly Msg[]): void {
		this.#storage.transactionSync(() => {
			for (const m of messages) {
				this.#sql.exec("INSERT INTO saavy_log (i, kind, text, size, date, key) VALUES (?, ?, ?, ?, ?, ?)", m.i, m.kind, m.text, m.size, m.date, m.key);
			}
		});
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
		return this.#sql
			.exec(`SELECT i, kind, text FROM saavy_log WHERE ${where.join(" AND ")} ORDER BY i DESC LIMIT ?`, ...bindings)
			.toArray()
			.map((row) => ({ i: Number(row.i), kind: String(row.kind) as Kind, text: String(row.text) }));
	}

	logDates(since: number): number[] {
		return this.#sql
			.exec("SELECT date FROM saavy_log WHERE date >= ? ORDER BY i", since)
			.toArray()
			.map((row) => Number(row.date));
	}

	lastEntry(): number {
		return Number(this.#meta("last_entry") ?? 0);
	}

	setLastEntry(id: number): void {
		this.#setMeta("last_entry", String(id));
	}

	treeGet(l: number, i: number): Node | undefined {
		const rows = this.#sql.exec("SELECT l, i, text, size, key FROM saavy_tree WHERE l = ? AND i = ?", l, i).toArray();
		if (rows.length === 0) return undefined;
		const row = rows[0]!;
		return { l: Number(row.l), i: Number(row.i), text: String(row.text), size: Number(row.size), key: String(row.key) };
	}

	treePut(node: Node): void {
		// Nodes are never recomputed: the first one stored for (l, i) stays.
		if (this.treeGet(node.l, node.i) !== undefined) return;
		this.#sql.exec("INSERT INTO saavy_tree (l, i, text, size, key) VALUES (?, ?, ?, ?, ?)", node.l, node.i, node.text, node.size, node.key);
		this.#treeSize++;
	}

	treeSize(): number {
		return this.#treeSize;
	}

	viewLoad(): { parts: Part[]; covers: number } | undefined {
		const saved = this.#meta("view");
		return saved === undefined ? undefined : (JSON.parse(saved) as { parts: Part[]; covers: number });
	}

	viewSave(parts: readonly Part[], covers: number): void {
		this.#setMeta("view", JSON.stringify({ parts, covers }));
	}
}

function toMsg(row: Record<string, SqlStorageValue>): Msg {
	return { i: Number(row.i), kind: String(row.kind) as Kind, text: String(row.text), size: Number(row.size), date: Number(row.date), key: String(row.key) };
}
