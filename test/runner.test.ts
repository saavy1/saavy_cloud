import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WireResult } from "../core/protocol.ts";
import { type Outcome, ResultCache } from "../runner/cache.ts";

const ok = (value: unknown, output = ""): Outcome => ({ result: { ok: true, value }, output });

test("a repeated key gets the first outcome, output included: joined while running, saved after, and across a restart", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "saavy-cache-")), "cache.jsonl");
	const cache = new ResultCache(path);
	let runs = 0;
	let finish: (outcome: Outcome) => void = () => {};
	const run = () => {
		runs++;
		return new Promise<Outcome>((resolve) => {
			finish = resolve;
		});
	};
	const first = cache.run("task:0", run);
	const second = cache.run("task:0", run);
	finish(ok({ exitCode: 0 }, "hello\n"));
	assert.deepEqual(await first, { outcome: ok({ exitCode: 0 }, "hello\n"), fresh: true });
	assert.deepEqual(await second, { outcome: ok({ exitCode: 0 }, "hello\n"), fresh: false });
	assert.equal((await cache.run("task:0", run)).fresh, false);
	assert.equal(runs, 1);
	assert.deepEqual((await new ResultCache(path).run("task:0", run)).outcome.output, "hello\n");
	assert.equal(runs, 1);
});

test("an aborted run is not kept, so a repeat runs again", async () => {
	const cache = new ResultCache();
	let runs = 0;
	const aborted: WireResult = { ok: false, error: { kind: "exec", code: "aborted", message: "Aborted." } };
	await cache.run("task:1", async () => (runs++, { result: aborted, output: "" }));
	assert.deepEqual((await cache.run("task:1", async () => (runs++, ok("again")))).outcome, ok("again"));
	assert.equal(runs, 2);
});
