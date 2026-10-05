// Bringing a memory built elsewhere (import/run.ts) into the brain: rows arrive in batches into staging tables, then
// one transaction makes the imported history the start of the log, with the live log moved after it in its order.
// The imported tree and view come along; the live messages' summaries are rebuilt where they now sit. What was there
// before is kept in *_backup tables. The brain restarts afterwards, so every cache reloads from the new tables.
import type { Part } from "../core/store.ts";

export interface LogRow {
	readonly i: number;
	readonly kind: string;
	readonly text: string;
	readonly size: number;
	readonly date: number;
	readonly key: string;
}

export interface TreeRow {
	readonly l: number;
	readonly i: number;
	readonly text: string;
	readonly size: number;
	readonly key: string;
}

export class MemoryImport {
	readonly #storage: DurableObjectStorage;
	readonly #sql: SqlStorage;

	constructor(storage: DurableObjectStorage) {
		this.#storage = storage;
		this.#sql = storage.sql;
	}

	/** Empty staging tables for a new upload. */
	begin(): void {
		this.#sql.exec(`
			DROP TABLE IF EXISTS saavy_import_log;
			DROP TABLE IF EXISTS saavy_import_tree;
			CREATE TABLE saavy_import_log (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, date INTEGER NOT NULL, key TEXT NOT NULL);
			CREATE TABLE saavy_import_tree (l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (l, i));
		`);
	}

	/** One batch of staged rows; how many each table now holds. */
	add(log: readonly LogRow[], tree: readonly TreeRow[]): { log: number; tree: number } {
		this.#storage.transactionSync(() => {
			for (const r of log) this.#sql.exec("INSERT OR REPLACE INTO saavy_import_log (i, kind, text, size, date, key) VALUES (?, ?, ?, ?, ?, ?)", r.i, r.kind, r.text, r.size, r.date, r.key);
			for (const r of tree) this.#sql.exec("INSERT OR REPLACE INTO saavy_import_tree (l, i, text, size, key) VALUES (?, ?, ?, ?, ?)", r.l, r.i, r.text, r.size, r.key);
		});
		return this.#counts();
	}

	#counts(): { log: number; tree: number } {
		return {
			log: Number(this.#sql.exec("SELECT COUNT(*) AS n FROM saavy_import_log").one().n),
			tree: Number(this.#sql.exec("SELECT COUNT(*) AS n FROM saavy_import_tree").one().n),
		};
	}

	/**
	 * Swap the staged memory in. `expect` guards against a partial upload; `view` is the importer's saved view (its
	 * parts cover the imported rows; the live rows fold in when the brain restarts).
	 */
	commit(expect: { log: number; tree: number }, view: { parts: Part[]; covers: number } | undefined): { imported: number; live: number } {
		const counts = this.#counts();
		if (counts.log !== expect.log || counts.tree !== expect.tree) throw new Error(`Upload incomplete: staged ${counts.log}/${expect.log} messages, ${counts.tree}/${expect.tree} summaries.`);
		const max = Number(this.#sql.exec("SELECT COALESCE(MAX(i) + 1, 0) AS n FROM saavy_import_log").one().n);
		if (max !== counts.log) throw new Error(`Staged messages are not contiguous (${counts.log} rows, ids to ${max - 1}).`);
		let live = 0;
		this.#storage.transactionSync(() => {
			this.#sql.exec(`
				DROP TABLE IF EXISTS saavy_log_backup;
				DROP TABLE IF EXISTS saavy_tree_backup;
				CREATE TABLE saavy_log_backup AS SELECT * FROM saavy_log;
				CREATE TABLE saavy_tree_backup AS SELECT * FROM saavy_tree;
				DELETE FROM saavy_log;
				DELETE FROM saavy_tree;
				INSERT INTO saavy_log SELECT * FROM saavy_import_log;
				INSERT INTO saavy_tree SELECT * FROM saavy_import_tree;
			`);
			// The live conversation, after the imported history, in its order.
			live = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM saavy_log_backup").one().n);
			this.#sql.exec("INSERT INTO saavy_log (i, kind, text, size, date, key) SELECT i + ?, kind, text, size, date, key FROM saavy_log_backup ORDER BY i", counts.log);
			if (view === undefined) this.#sql.exec("DELETE FROM saavy_meta WHERE k = 'view'");
			else this.#sql.exec("INSERT INTO saavy_meta (k, v) VALUES ('view', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(view));
			this.#sql.exec("DROP TABLE saavy_import_log; DROP TABLE saavy_import_tree;");
		});
		return { imported: counts.log, live };
	}
}
