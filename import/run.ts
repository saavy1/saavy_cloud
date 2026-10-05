// The import: past sessions into a memory, built locally with the same core as the brain, then uploaded.
//
//   node import/run.ts plan                         what would be imported (no model calls)
//   node import/run.ts build [--limit N] [--model provider/id] [--db path]
//                                                   build the log and its summaries; resumable, and a larger --limit
//                                                   later extends the same log (sessions keep their order)
//   node import/run.ts samples [--db path]          summaries from each level, to judge their quality
//
// The compactor model defaults to opencode-go/space-bunny-free: OPENCODE_API_KEY, else ~/.saavy/import/opencode.key.
// openrouter/… models use OPENROUTER_API_KEY, else pi's auth.json.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
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
	const { sessions, skipped } = collect();
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
	const opencodeKey = join(homedir(), ".saavy", "import", "opencode.key");
	if (process.env.OPENCODE_API_KEY === undefined && existsSync(opencodeKey)) process.env.OPENCODE_API_KEY = readFileSync(opencodeKey, "utf8").trim();
	if (process.env.OPENROUTER_API_KEY === undefined) {
		const auth = join(homedir(), ".pi", "agent", "auth.json");
		const key = existsSync(auth) ? (JSON.parse(readFileSync(auth, "utf8")) as { openrouter?: { key?: string } }).openrouter?.key : undefined;
		if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
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
	const slash = spec.indexOf("/");
	const runtime = models();
	const model = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) as Model<Api> | undefined;
	if (model === undefined) throw new Error(`Unknown model ${spec}`);
	if (spec.startsWith("opencode-go/") && process.env.OPENCODE_API_KEY === undefined) throw new Error("Put your OpenCode Go key in ~/.saavy/import/opencode.key (or set OPENCODE_API_KEY).");

	mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	const store = new NodeSqliteStore(dbPath);
	const planned = rows(collect().sessions, limit);
	const have = store.logLength();
	if (have > planned.rows.length) throw new Error(`${dbPath} already holds ${have} rows, more than this --limit plans (${planned.rows.length}).`);
	// The rows already stored must be the same ones (same order); then the rest is appended.
	for (const probe of [0, have - 1]) if (have > 0 && store.logGet(probe)?.key !== planned.rows[probe]!.key) throw new Error(`${dbPath} was built from a different plan; use a fresh --db.`);

	const meter = new Meter();
	const memory = new Memory(store, { models: meter.wrap(runtime), current: () => ({ model, thinking: "off" }) });
	memory.subscribe((event) => {
		if (event.type === "failed") console.log(`  ! ${event.l}:${event.i} ${event.error.message.slice(0, 160)}`);
	});
	const fresh = planned.rows.slice(have).map((row) => ({ ...row, size: bytes(`${row.kind}: ${row.text}`) }));
	console.log(`${spec}: ${have} rows stored, appending ${fresh.length} (${planned.sessions} sessions); secrets redacted ${JSON.stringify(planned.hits)}`);
	for (let at = 0; at < fresh.length; at += 2000) memory.log.append(fresh.slice(at, at + 2000));
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

if (verb === "plan") plan();
else if (verb === "build") await build();
else if (verb === "samples") samples();
else console.log("Usage: node import/run.ts plan | build [--limit N] [--model provider/id] [--db path] | samples [--db path]");
