import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MemoryImport } from "../brain/importer.ts";

/** Enough of a Durable Object's storage, over node:sqlite, for the brain's import code. */
function storage(): DurableObjectStorage {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = bindings.length === 0 && query.includes(";") ? (db.exec(query), []) : (db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[]);
			return { toArray: () => rows, one: () => rows[0]! };
		},
	};
	return {
		sql,
		transactionSync<T>(fn: () => T): T {
			db.exec("BEGIN");
			try {
				const out = fn();
				db.exec("COMMIT");
				return out;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DurableObjectStorage;
}

test("an imported memory becomes the start of the log; the live chat follows it, in order", () => {
	const s = storage();
	s.sql.exec(`
		CREATE TABLE saavy_log (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, date INTEGER NOT NULL, key TEXT NOT NULL);
		CREATE TABLE saavy_tree (l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, size INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (l, i));
		CREATE TABLE saavy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
	`);
	for (let i = 0; i < 3; i++) s.sql.exec("INSERT INTO saavy_log VALUES (?, 'user', ?, 1, ?, ?)", i, `live ${i}`, 2000 + i, `live:${i}`);
	s.sql.exec("INSERT INTO saavy_tree VALUES (0, 0, 'live summary', 1, 'live:0')");

	const importer = new MemoryImport(s);
	importer.begin();
	const log = Array.from({ length: 5 }, (_, i) => ({ i, kind: "user", text: `old ${i}`, size: 1, date: 1000 + i, key: `old:${i}` }));
	importer.add(log.slice(0, 3), []);
	const staged = importer.add(log.slice(3), [{ l: 0, i: 0, text: "old summary", size: 1, key: "old:0" }]);
	assert.deepEqual(staged, { log: 5, tree: 1 });
	assert.throws(() => importer.commit({ log: 6, tree: 1 }, undefined), /incomplete/);

	const result = importer.commit({ log: 5, tree: 1 }, { parts: [{ l: 0, i: 0 }], covers: 1 });
	assert.deepEqual(result, { imported: 5, live: 3 });
	const texts = s.sql.exec("SELECT i, text FROM saavy_log ORDER BY i").toArray().map((row) => `${row.i}:${row.text}`);
	assert.deepEqual(texts, ["0:old 0", "1:old 1", "2:old 2", "3:old 3", "4:old 4", "5:live 0", "6:live 1", "7:live 2"]);
	// The imported tree only: live summaries no longer fit their positions and are rebuilt.
	assert.deepEqual(s.sql.exec("SELECT text FROM saavy_tree").toArray().map((row) => row.text), ["old summary"]);
	assert.equal(s.sql.exec("SELECT COUNT(*) AS n FROM saavy_log_backup").one().n, 3);
	assert.deepEqual(JSON.parse(String(s.sql.exec("SELECT v FROM saavy_meta WHERE k = 'view'").one().v)), { parts: [{ l: 0, i: 0 }], covers: 1 });
});
