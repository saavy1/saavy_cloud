// The import: past sessions into a memory, built locally with the same core as the brain, then uploaded.
//
//   node import/run.ts plan                         what would be imported (no model calls)
//   node import/run.ts build [--limit N] [--model provider/id] [--thinking level] [--jobs 32] [--lookahead 64] [--db path]
//                     [--sources all|coding] [--reuse old.sqlite]   coding: the coding agents only (no chat-app exports);
//                                                   reuse: take single-message summaries an earlier build made
//                                                   build the log and its summaries; resumable, and a larger --limit
//                                                   later extends the same log (sessions keep their order)
//   node import/run.ts samples [--db path]          summaries from each level, to judge their quality
//   node import/run.ts upload [--db path]           put the built memory into the brain, ahead of the live chat
//                                                   (as this signed-in device; the brain restarts to load it)
//
// The compactor model defaults to opencode-go/space-bunny-free. Keys come from pi's auth.json, as the local agent's
// /login stores them (/login opencode-go, /login openrouter), or from OPENCODE_API_KEY / OPENROUTER_API_KEY.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { bytes } from "../core/log.ts";
import { Memory } from "../core/memory.ts";
import type { Kind } from "../core/store.ts";
import { scrub } from "./scrub.ts";
import { collect, type ImportSession } from "./sources.ts";
import { NodeSqliteStore } from "./store.ts";

const arg = (name: string): string | undefined => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
};
const verb = process.argv[2] ?? "plan";
const dbPath = arg("db") ?? join(homedir(), ".saavy", "import", "memory.sqlite");

const when = (ms: number) => new Date(ms).toLocaleString("sv-SE").slice(0, 16);

interface Row {
	readonly kind: Kind;
	readonly text: string;
	readonly date: number;
	readonly key: string;
}

/** The sessions as log rows: a header note per session, then its messages, secrets redacted. */
function rows(sessions: readonly ImportSession[], limit: number): { rows: Row[]; hits: Record<string, number>; sessions: number } {
	const out: Row[] = [];
	const hits: Record<string, number> = {};
	let count = 0;
	for (const session of sessions) {
		if (out.length >= limit) break;
		count++;
		const title = session.title ? ` "${session.title.replace(/\s+/g, " ").slice(0, 80)}"` : "";
		out.push({ kind: "note", text: `[imported ${session.source} session${title} · ${session.cwd ?? "?"} · ${when(session.start)}]`, date: session.start, key: `${session.source}:${session.id}:start` });
		for (const message of session.messages) {
			const clean = scrub(message.text);
			for (const [kind, n] of Object.entries(clean.hits)) hits[kind] = (hits[kind] ?? 0) + n;
			out.push({ ...message, text: clean.text });
		}
	}
	return { rows: out, hits, sessions: count };
}

function plan(): void {
	const { sessions, skipped } = collect(arg("sources") !== "coding");
	const all = rows(sessions, Number.POSITIVE_INFINITY);
	const bySource = new Map<string, { sessions: number; messages: number; over: number; bytes: number }>();
	for (const session of sessions) {
		const entry = bySource.get(session.source) ?? { sessions: 0, messages: 0, over: 0, bytes: 0 };
		entry.sessions++;
		for (const message of session.messages) {
			const size = bytes(`${message.kind}: ${message.text}`);
			entry.messages++;
			entry.bytes += size;
			if (size > 512) entry.over++;
		}
		bySource.set(session.source, entry);
	}
	console.log("source     sessions   messages  over 512 B        MB");
	for (const [source, s] of bySource) console.log(`${source.padEnd(10)} ${String(s.sessions).padStart(8)} ${String(s.messages).padStart(10)} ${String(s.over).padStart(11)} ${(s.bytes / 1e6).toFixed(1).padStart(9)}`);
	console.log(`\n${all.rows.length} log rows (with one header note per session), ${all.sessions} sessions, ${when(sessions[0]!.start)} → ${when(sessions.at(-1)!.start)}`);
	console.log("skipped:", skipped.map((s) => `${s.reason}: ${s.sessions} sessions, ${s.messages} messages`).join("; "));
	console.log("secrets redacted:", JSON.stringify(all.hits));
}

function models(): Models {
	const runtime = createModels();
	runtime.setProvider(opencodeGoProvider());
	runtime.setProvider(openrouterProvider());
	const authFile = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
	const auth = existsSync(authFile) ? (JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { key?: string }>) : {};
	for (const [provider, variable] of [["opencode-go", "OPENCODE_API_KEY"], ["openrouter", "OPENROUTER_API_KEY"]] as const) {
		const key = auth[provider]?.key;
		if (process.env[variable] === undefined && key !== undefined) process.env[variable] = key;
	}
	return runtime;
}

/** Calls, time, tokens and failures of the compactor, for judging cost and limits. */
class Meter {
	calls = 0;
	failed = 0;
	ms = 0;
	input = 0;
	cached = 0;
	output = 0;
	readonly errors = new Map<string, number>();

	wrap(runtime: Models): Models {
		return new Proxy(runtime, {
			get: (target, key) => {
				const value = Reflect.get(target, key);
				if (key !== "streamSimple") return typeof value === "function" ? value.bind(target) : value;
				return (...args: unknown[]) => {
					const started = Date.now();
					const stream = (value as (...a: unknown[]) => { result(): Promise<AssistantMessage> }).apply(target, args);
					return new Proxy(stream, {
						get: (s, k) =>
							k === "result"
								? async () => {
										const reply = await s.result();
										this.calls++;
										this.ms += Date.now() - started;
										this.input += reply.usage?.input ?? 0;
										this.cached += reply.usage?.cacheRead ?? 0;
										this.output += reply.usage?.output ?? 0;
										if (reply.stopReason === "error" || reply.stopReason === "aborted") {
											this.failed++;
											const message = (reply.errorMessage ?? reply.stopReason).slice(0, 120);
											this.errors.set(message, (this.errors.get(message) ?? 0) + 1);
										}
										return reply;
									}
								: Reflect.get(s, k),
					});
				};
			},
		});
	}

	line(): string {
		const avg = this.calls === 0 ? 0 : Math.round(this.ms / this.calls);
		const cacheRate = this.input + this.cached === 0 ? 0 : Math.round((100 * this.cached) / (this.input + this.cached));
		return `${this.calls} calls (${this.failed} failed), avg ${avg} ms, tokens in ${(this.input / 1e6).toFixed(2)}M + cached ${(this.cached / 1e6).toFixed(2)}M (${cacheRate}%), out ${(this.output / 1e6).toFixed(3)}M`;
	}
}

async function build(): Promise<void> {
	const limit = Number(arg("limit") ?? Number.POSITIVE_INFINITY);
	const spec = arg("model") ?? "opencode-go/space-bunny-free";
	// minimal, not off: "off" sends no reasoning setting, and a reasoning model then thinks at length by default.
	const thinking = (arg("thinking") ?? "minimal") as ModelThinkingLevel | "off";
	const slash = spec.indexOf("/");
	const runtime = models();
	const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) as Model<Api> | undefined;
	if (model === undefined) throw new Error(`Unknown model ${spec}`);
	if (spec.startsWith("opencode-go/") && process.env.OPENCODE_API_KEY === undefined) throw new Error("No OpenCode Go key: run /login opencode-go in the local saavy (or pi), or set OPENCODE_API_KEY.");

	mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	const store = new NodeSqliteStore(dbPath);
	// The plan is frozen at the first build: sessions still in use keep growing, and a resume must see the same rows.
	const have = store.logLength();
	const cutoff = Number(store.meta("cutoff") ?? Date.now());
	if (store.meta("cutoff") === undefined) store.setMeta("cutoff", String(cutoff));
	// Which sources this database holds is fixed at its first build too (one built before the choice existed: coding).
	const sources = store.meta("sources") ?? (have > 0 ? "coding" : (arg("sources") ?? "all"));
	if (store.meta("sources") === undefined) store.setMeta("sources", sources);
	const frozen = collect(sources !== "coding").sessions.flatMap((session) => {
		const messages = session.messages.filter((message) => message.date <= cutoff);
		return messages.length === 0 ? [] : [{ ...session, messages }];
	});
	const planned = rows(frozen, limit);
	if (have > planned.rows.length) throw new Error(`${dbPath} already holds ${have} rows, more than this --limit plans (${planned.rows.length}).`);
	// The rows already stored must be the same ones (same order); then the rest is appended.
	for (const probe of [0, have - 1]) if (have > 0 && store.logGet(probe)?.key !== planned.rows[probe]!.key) throw new Error(`${dbPath} was built from a different plan; use a fresh --db.`);

	const meter = new Meter();
	const memory = new Memory(store, { models: meter.wrap(runtime), current: () => ({ model, thinking }), sessionId: `saavy-import-${store.meta("run") ?? "1"}`, jobs: Number(arg("jobs") ?? 32), lookahead: Number(arg("lookahead") ?? 64) });
	memory.subscribe((event) => {
		if (event.type === "failed") console.log(`  ! ${event.l}:${event.i} ${event.error.message.slice(0, 160)}`);
	});
	const fresh = planned.rows.slice(have).map((row) => ({ ...row, size: bytes(`${row.kind}: ${row.text}`) }));
	console.log(`${spec}: history up to ${when(cutoff)}; ${have} rows stored, appending ${fresh.length} (${planned.sessions} sessions); secrets redacted ${JSON.stringify(planned.hits)}`);
	for (let at = 0; at < fresh.length; at += 2000) memory.log.append(fresh.slice(at, at + 2000));
	// A message summarizes the same wherever it sits: take what an earlier build already wrote for it.
	const reuse = arg("reuse");
	if (reuse !== undefined && fresh.length > 0) {
		const old = new NodeSqliteStore(reuse);
		const known = new Map((old.db.prepare("SELECT g.key AS key, t.text AS text FROM saavy_tree t JOIN saavy_log g ON g.i = t.i WHERE t.l = 0").all() as { key: string; text: string }[]).map((row) => [row.key, row.text]));
		let reused = 0;
		for (let i = have; i < memory.log.length; i++) {
			const message = memory.log.at(i)!;
			const text = known.get(message.key);
			if (text === undefined || memory.tree.has(0, i)) continue;
			memory.tree.put({ l: 0, i, text, size: bytes(text), key: message.key });
			reused++;
		}
		console.log(`reused ${reused} single-message summaries from ${reuse}`);
		memory.view.fit();
	}
	memory.pump();

	const started = Date.now();
	let last = -1;
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 15_000));
		const view = memory.view;
		const unbuilt = view.unbuilt();
		const done = memory.tree.size;
		const minutes = ((Date.now() - started) / 60_000).toFixed(1);
		console.log(`[${minutes} min] ${done} nodes · view ${view.parts.length} lines, ${unbuilt} unbuilt, first unbuilt at ${view.first()}/${memory.log.length} · running ${memory.running} · ${meter.line()}`);
		if (meter.errors.size > 0) console.log(`  errors: ${JSON.stringify(Object.fromEntries(meter.errors))}`);
		if (memory.running === 0 && unbuilt === 0 && done === last) break;
		last = memory.running === 0 && unbuilt === 0 ? done : -1;
	}
	memory.close();
	console.log(`Done: ${memory.log.length} messages, ${memory.tree.size} summaries, view ${memory.view.size()} bytes. ${meter.line()}`);
}

function samples(): void {
	const store = new NodeSqliteStore(dbPath);
	const levels = store.db.prepare("SELECT l, COUNT(*) AS n, MAX(i) AS top FROM saavy_tree GROUP BY l ORDER BY l").all() as { l: number; n: number; top: number }[];
	for (const { l, n, top } of levels) {
		console.log(`\n── level ${l} (${n} nodes, each ${2 ** l} messages) ──`);
		const picks = l === 0 ? (store.db.prepare("SELECT i FROM saavy_tree t WHERE l = 0 AND (SELECT size FROM saavy_log WHERE i = t.i) > 512 ORDER BY random() LIMIT 3").all() as { i: number }[]).map((row) => row.i) : [...new Set([0, Math.floor(top / 2), top])];
		for (const i of picks) {
			const node = store.treeGet(l, i);
			if (node === undefined) continue;
			const source = l === 0 ? store.logGet(i) : undefined;
			if (source !== undefined) console.log(`  source (${source.size} B): ${source.kind}: ${source.text.replace(/\s+/g, " ").slice(0, 300)}…`);
			console.log(`  ${l}:${i} (${node.size} B): ${node.text.replace(/\s*\n\s*/g, " ")}`);
		}
	}
}

/** The built memory into the brain, in batches under the WebSocket message limit. */
async function upload(): Promise<void> {
	const store = new NodeSqliteStore(dbPath);
	const { readCredentials } = await import("../client/auth.ts");
	const { RemoteSaavy } = await import("../client/remote.ts");
	const { url, token } = readCredentials();
	if (token === undefined) throw new Error("Not signed in: run saavy auth login");
	const expect = {
		log: Number((store.db.prepare("SELECT COUNT(*) AS n FROM saavy_log").get() as { n: number }).n),
		tree: Number((store.db.prepare("SELECT COUNT(*) AS n FROM saavy_tree").get() as { n: number }).n),
	};
	const unbuilt = new Memory(store, { models: createModels(), current: () => ({ model: undefined, thinking: "off" }) });
	const pending = unbuilt.view.unbuilt();
	unbuilt.close();
	if (pending > 0 && !process.argv.includes("--partial")) throw new Error(`${pending} view lines are not summarized yet; finish the build first (or pass --partial).`);
	const brain = await RemoteSaavy.connect(url, token, join(homedir(), ".saavy", "cloud"));
	const BATCH = 600_000;
	const send = async (log: unknown[], tree: unknown[]) => brain.call<{ log: number; tree: number }>("importAdd", log, tree);
	try {
		await brain.call("importBegin");
		let at = { log: 0, tree: 0 };
		for (const [table, query] of [
			["log", "SELECT i, kind, text, size, date, key FROM saavy_log ORDER BY i"],
			["tree", "SELECT l, i, text, size, key FROM saavy_tree ORDER BY l, i"],
		] as const) {
			let batch: unknown[] = [];
			let bytes = 0;
			for (const row of store.db.prepare(query).iterate() as Iterable<Record<string, unknown>>) {
				const size = String(row.text).length + 200;
				if (bytes + size > BATCH && batch.length > 0) {
					at = table === "log" ? await send(batch, []) : await send([], batch);
					batch = [];
					bytes = 0;
					process.stdout.write(`\r${at.log}/${expect.log} messages, ${at.tree}/${expect.tree} summaries`);
				}
				batch.push({ ...row });
				bytes += size;
			}
			if (batch.length > 0) at = table === "log" ? await send(batch, []) : await send([], batch);
		}
		console.log(`\r${at.log}/${expect.log} messages, ${at.tree}/${expect.tree} summaries staged`);
		const view = store.viewLoad() ?? null;
		const result = await brain.call<{ imported: number; live: number }>("importCommit", expect, view);
		console.log(`The brain now holds ${result.imported} imported messages, then the ${result.live} of the live chat. It restarts to load them; the live messages are summarized again in their new place.`);
	} finally {
		brain.close();
	}
}

if (verb === "plan") plan();
else if (verb === "upload") await upload();
else if (verb === "build") await build();
else if (verb === "samples") samples();
else console.log("Usage: node import/run.ts plan | build [options] | samples [--db path] | upload [--db path]");
