// A one-page HTML report of an import build: how the run went, what came in, quality checks, what the agent will see,
// and samples from every level of the tree. Self-contained (no network); private (0600), since it quotes the history.
//
//   node import/report.ts [--db ~/.saavy/import/memory-all.sqlite] [--log ~/.saavy/import/import-all.log] [--out …]
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Memory } from "../core/memory.ts";
import { start } from "../core/tree.ts";
import { NodeSqliteStore } from "./store.ts";

const arg = (name: string, fallback: string): string => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? fallback : process.argv[at + 1]!;
};
const dir = join(homedir(), ".saavy", "import");
const dbPath = arg("db", join(dir, "memory-all.sqlite"));
const logPath = arg("log", join(dir, "import-all.log"));
const outPath = arg("out", join(dir, "report.html"));

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)}…`);
const num = (n: number): string => n.toLocaleString("en-US");
const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const store = new NodeSqliteStore(dbPath);
const db = store.db;
const all = <T>(sql: string, ...params: (string | number)[]): T[] => db.prepare(sql).all(...params) as T[];
const one = <T>(sql: string, ...params: (string | number)[]): T => db.prepare(sql).get(...params) as T;

// ─── the run, from the log ───

interface Segment {
	readonly minutes: number;
	readonly calls: number;
	readonly failed: number;
	readonly avgMs: number;
	readonly input: number;
	readonly cached: number;
	readonly output: number;
}

const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const header = log.split("\n").find((line) => line.startsWith("opencode-go/") || /^[a-z-]+\/[\w.-]+: history up to/.test(line)) ?? "";
const model = header.split(":")[0] ?? "?";
const redacted = (() => {
	const match = /secrets redacted (\{.*\})/.exec(header);
	return match ? (JSON.parse(match[1]!) as Record<string, number>) : {};
})();
const segments: Segment[] = log
	.split(/\n(?=[a-z-]+\/[\w.-]+: history up to)/)
	.map((part) => {
		const lines = part.split("\n").filter((line) => /^\[[\d.]+ min\]/.test(line));
		const last = lines.at(-1);
		if (last === undefined) return undefined;
		const pick = (re: RegExp) => Number(re.exec(last)?.[1] ?? 0);
		return {
			minutes: pick(/^\[([\d.]+) min\]/),
			calls: pick(/ (\d+) calls/),
			failed: pick(/\((\d+) failed\)/),
			avgMs: pick(/avg (\d+) ms/),
			input: pick(/tokens in ([\d.]+)M/) * 1e6,
			cached: pick(/cached ([\d.]+)M/) * 1e6,
			output: pick(/out ([\d.]+)M/) * 1e6,
		};
	})
	.filter((segment): segment is Segment => segment !== undefined);
const total = segments.reduce(
	(sum, s) => ({ minutes: sum.minutes + s.minutes, calls: sum.calls + s.calls, failed: sum.failed + s.failed, ms: sum.ms + s.avgMs * s.calls, input: sum.input + s.input, cached: sum.cached + s.cached, output: sum.output + s.output }),
	{ minutes: 0, calls: 0, failed: 0, ms: 0, input: 0, cached: 0, output: 0 },
);
const done = /^Done: .*$/m.exec(log)?.[0];
const restarts = (log.match(/^--- /gm) ?? []).length;

// ─── the memory ───

const cutoff = Number(store.meta("cutoff") ?? 0);
const messages = one<{ n: number }>("SELECT COUNT(*) AS n FROM saavy_log").n;
const span = one<{ a: number; b: number }>("SELECT MIN(date) AS a, MAX(date) AS b FROM saavy_log");
const sources = all<{ source: string; sessions: number; messages: number; bytes: number }>(`
	SELECT CASE WHEN key LIKE 'claude.ai%' THEN 'claude.ai' ELSE substr(key, 1, instr(key, ':') - 1) END AS source,
		SUM(key LIKE '%:start') AS sessions, SUM(key NOT LIKE '%:start') AS messages, SUM(size) AS bytes
	FROM saavy_log GROUP BY source ORDER BY messages DESC`);
const months = all<{ month: string; n: number }>("SELECT strftime('%Y-%m', date / 1000, 'unixepoch') AS month, COUNT(*) AS n FROM saavy_log GROUP BY month ORDER BY month");
const kinds = all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM saavy_log GROUP BY kind ORDER BY n DESC");
const levels = all<{ l: number; n: number; avg: number; over: number }>("SELECT l, COUNT(*) AS n, AVG(size) AS avg, SUM(size > 512) AS over FROM saavy_tree GROUP BY l ORDER BY l");
const checks = one<{ example: number; marker: number; ruler: number; over: number; empty: number }>(`
	SELECT SUM(text LIKE '%prod.yaml%' AND text LIKE '%stream.ts%') AS example, SUM(instr(text, '← LIMIT') > 0) AS marker,
		SUM(text LIKE '%.....64%') AS ruler, SUM(size > 512) AS over, SUM(trim(text) = '') AS empty FROM saavy_tree`);
const nodes = levels.reduce((sum, level) => sum + level.n, 0);

const memory = new Memory(store, { models: createModels(), current: () => ({ model: undefined, thinking: "off" }) });
const view = memory.view;
const viewLines = view.parts.map((part) => ({ part, text: view.text(part) }));
const unbuilt = view.unbuilt();
const viewBytes = view.size();
const viewLevels = new Map<number, number>();
for (const part of view.parts) viewLevels.set(part.l, (viewLevels.get(part.l) ?? 0) + 1);
// Not memory.close(): that saves the view, and this database may still be building.

// ─── samples ───

interface Sample {
	readonly l: number;
	readonly i: number;
	readonly text: string;
	readonly source?: { kind: string; text: string; size: number; key: string };
}

const sampleLeaves = (source: string, count: number): Sample[] =>
	all<{ i: number; text: string; skind: string; stext: string; ssize: number; key: string }>(
		`SELECT t.i, t.text, g.kind AS skind, g.text AS stext, g.size AS ssize, g.key FROM saavy_tree t JOIN saavy_log g ON g.i = t.i
		 WHERE t.l = 0 AND g.size > 1500 AND g.key LIKE ? || '%' AND g.kind != 'note' ORDER BY random() LIMIT ?`,
		source,
		count,
	).map((row) => ({ l: 0, i: row.i, text: row.text, source: { kind: row.skind, text: row.stext, size: row.ssize, key: row.key } }));
const leafSamples = sources.flatMap((s) => sampleLeaves(s.source, s.messages > 5000 ? 2 : 1));
const top = levels.at(-1)?.l ?? 0;
const mergeLevels = [2, 5, 8, 11].filter((l) => l < top);
const mergeSamples: Sample[] = mergeLevels.flatMap((l) => all<{ i: number; text: string }>("SELECT i, text FROM saavy_tree WHERE l = ? ORDER BY random() LIMIT 2", l).map((row) => ({ l, i: row.i, text: row.text })));
const roots: Sample[] = all<{ l: number; i: number; text: string }>("SELECT l, i, text FROM saavy_tree WHERE l >= ? ORDER BY l DESC, i", Math.max(0, top - 1)).map((row) => ({ l: row.l, i: row.i, text: row.text }));

const range = (s: Sample) => `messages ${num(start(s.l, s.i))}–${num(start(s.l, s.i) + 2 ** s.l - 1)}`;
const dateOf = (i: number) => {
	const row = one<{ date: number } | undefined>("SELECT date FROM saavy_log WHERE i = ?", Math.min(i, messages - 1));
	return row === undefined ? "" : new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const spanOf = (s: Sample) => `${dateOf(start(s.l, s.i))} → ${dateOf(start(s.l, s.i) + 2 ** s.l - 1)}`;

// ─── the page ───

const verdictOk = done !== undefined && unbuilt === 0 && checks.example === 0 && checks.marker === 0 && checks.ruler === 0 && checks.over === 0;
const maxMonth = Math.max(...months.map((m) => m.n));
const chart = (() => {
	const w = 640;
	const h = 150;
	const bw = w / months.length;
	const bars = months
		.map((m, n) => {
			const bh = Math.max(2, (m.n / maxMonth) * (h - 28));
			const label = new Date(`${m.month}-15`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
			return `<g><title>${m.month}: ${num(m.n)} messages</title><rect x="${n * bw + 3}" y="${h - 18 - bh}" width="${bw - 6}" height="${bh}" rx="3" class="bar"/><text x="${n * bw + bw / 2}" y="${h - 4}" class="axis">${label}</text></g>`;
		})
		.join("");
	return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Messages per month">${bars}</svg>`;
})();

const checkRow = (ok: boolean, label: string, detail: string) => `<li class="${ok ? "ok" : "bad"}"><span class="mark">${ok ? "✓" : "✗"}</span><span><b>${label}</b> ${detail}</span></li>`;
const sampleCard = (s: Sample) => `
	<article class="sample">
		<div class="meta"><span class="pill">level ${s.l}${s.l === 0 ? " · one message" : ` · ${num(2 ** s.l)} messages`}</span><span>${range(s)}</span><span>${spanOf(s)}</span>${s.source ? `<span>${esc(s.source.key.split(":")[0]!)}</span>` : ""}</div>
		${s.source ? `<details><summary>original ${esc(s.source.kind)} message, ${num(s.source.size)} bytes</summary><pre>${esc(clip(s.source.text, 2500))}</pre></details>` : ""}
		<p>${esc(flat(s.text))}</p>
	</article>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>saavy import report</title>
<style>
:root { --bg:#f7f6f3; --card:#fff; --fg:#1c1b19; --muted:#6c6963; --line:#e4e1db; --accent:#3d5afe; --ok:#2e7d32; --bad:#c62828; --soft:#eef0ff; }
@media (prefers-color-scheme: dark) { :root { --bg:#131312; --card:#1c1b1a; --fg:#ecebe7; --muted:#9b978f; --line:#2d2b28; --accent:#8c9eff; --ok:#81c784; --bad:#ef9a9a; --soft:#22253a; } }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui,-apple-system,sans-serif; }
main { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:28px; margin:0 0 4px } h2 { font-size:19px; margin:40px 0 12px } .sub { color:var(--muted); margin:0 0 20px }
.hero { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:22px 24px; }
.verdict { display:inline-block; font-weight:600; padding:4px 12px; border-radius:999px; margin-bottom:12px; }
.verdict.ok { background:color-mix(in srgb,var(--ok) 15%,transparent); color:var(--ok) } .verdict.bad { background:color-mix(in srgb,var(--bad) 15%,transparent); color:var(--bad) }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px }
.stat { background:var(--bg); border-radius:12px; padding:12px 14px } .stat b { display:block; font-size:22px } .stat span { color:var(--muted); font-size:13px }
.go { background:var(--soft); border:1px solid color-mix(in srgb,var(--accent) 35%,transparent); border-radius:14px; padding:16px 20px; margin-top:16px }
.go code { background:var(--card); padding:2px 6px; border-radius:6px }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden }
th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums } th { color:var(--muted); font-weight:500; font-size:13px } td.n { text-align:right }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px }
svg { width:100%; height:auto } .bar { fill:var(--accent) } .axis { fill:var(--muted); font-size:10px; text-anchor:middle }
ul.checks { list-style:none; padding:0; margin:0 } ul.checks li { display:flex; gap:10px; padding:6px 0 } .mark { font-weight:700 } li.ok .mark { color:var(--ok) } li.bad .mark { color:var(--bad) }
.sample { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 18px; margin:10px 0 }
.sample p { margin:8px 0 0 } .meta { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--muted); font-size:13px }
.pill { background:var(--soft); color:var(--accent); border-radius:999px; padding:0 8px; font-weight:600 }
details summary { cursor:pointer; color:var(--muted); font-size:13px; margin-top:8px } pre { white-space:pre-wrap; word-break:break-word; background:var(--bg); padding:10px; border-radius:8px; font-size:12.5px; max-height:320px; overflow:auto }
.view { font:12.5px/1.5 ui-monospace,monospace; max-height:520px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px }
.view div { padding:2px 0; border-bottom:1px dashed var(--line) } .view i { color:var(--accent); font-style:normal }
ol.notes li { margin:6px 0 }
</style></head><body><main>
<h1>Your history, imported</h1>
<p class="sub">saavy bulk import · built ${esc(when(Date.now()))} · history up to ${esc(when(cutoff))}</p>

<section class="hero">
	<span class="verdict ${verdictOk ? "ok" : "bad"}">${verdictOk ? "Ready to upload" : done === undefined ? "Build not finished" : "Needs a look before uploading"}</span>
	<div>${num(messages)} messages from ${num(sources.reduce((n, s) => n + s.sessions, 0))} sessions, ${esc(when(span.a))} → ${esc(when(span.b))}, summarized into ${num(nodes)} lines by <b>${esc(model)}</b>.</div>
	<div class="stats">
		<div class="stat"><b>${num(messages)}</b><span>messages, word for word</span></div>
		<div class="stat"><b>${num(nodes)}</b><span>summaries, ${top + 1} levels</span></div>
		<div class="stat"><b>${(total.minutes / 60).toFixed(1)} h</b><span>build time, ${num(total.calls)} model calls</span></div>
		<div class="stat"><b>${total.calls === 0 ? "–" : (total.ms / total.calls / 1000).toFixed(1)} s</b><span>per call · ${num(total.failed)} retried</span></div>
		<div class="stat"><b>$0</b><span>${((total.input + total.cached) / 1e9).toFixed(2)} B tokens in (${Math.round((100 * total.cached) / Math.max(1, total.input + total.cached))}% cached)</span></div>
		<div class="stat"><b>${num(Object.values(redacted).reduce((a, b) => a + b, 0))}</b><span>secrets redacted before sending</span></div>
	</div>
	<div class="go"><b>To put this into saavy:</b> come back to the chat and say <i>“run the upload”</i>. It streams the memory into the brain, puts it ahead of today’s chat (kept, in order), keeps the old tables as a backup, and restarts the brain; your next message is answered with all of this in view.${done === undefined ? " <br><b>Not yet:</b> the build had not finished when this page was made." : ""}</div>
</section>

<h2>Quality checks</h2>
<div class="card"><ul class="checks">
	${checkRow(done !== undefined, "Build finished", done ? esc(done.replace(/^Done: /, "")) : "the log has no Done line yet")}
	${checkRow(unbuilt === 0, "Every view line summarized", `${num(unbuilt)} lines still pending`)}
	${checkRow(checks.example === 0, "No copied prompt example", `${num(checks.example)} summaries contain the old sample line (the pilot had hundreds)`)}
	${checkRow(checks.marker === 0 && checks.ruler === 0, "No leaked prompt markers", `${num(checks.marker)} retry markers, ${num(checks.ruler)} copies of the scale ruler`)}
	${checkRow(checks.over === 0, "Every summary within 512 bytes", `${num(checks.over)} over the limit`)}
	${checkRow(checks.empty === 0, "No empty summaries", `${num(checks.empty)} empty`)}
</ul></div>

<h2>What came in</h2>
<table><thead><tr><th>source</th><th class="n">sessions</th><th class="n">messages</th><th class="n">MB</th></tr></thead><tbody>
${sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="n">${num(s.sessions)}</td><td class="n">${num(s.messages)}</td><td class="n">${(s.bytes / 1e6).toFixed(1)}</td></tr>`).join("")}
</tbody></table>
<p class="sub" style="margin-top:8px">By kind: ${kinds.map((k) => `${esc(k.kind)} ${num(k.n)}`).join(" · ")}. Left out on purpose: subagent transcripts, /tmp sessions, Hermes cron runs, Claude SDK sessions, thinking, injected context. Secrets redacted: ${Object.entries(redacted).map(([k, n]) => `${esc(k)} ${n}`).join(", ") || "none"}.</p>
<div class="card">${chart}</div>

<h2>The tree</h2>
<table><thead><tr><th>level</th><th>each line covers</th><th class="n">lines</th><th class="n">avg bytes</th></tr></thead><tbody>
${levels.map((l) => `<tr><td>${l.l}</td><td>${l.l === 0 ? "one message" : `${num(2 ** l.l)} messages`}</td><td class="n">${num(l.n)}</td><td class="n">${Math.round(l.avg)}</td></tr>`).join("")}
</tbody></table>

<h2>The very top</h2>
<p class="sub">The coarsest lines: each one compresses thousands of messages. This is the oldest part of what the agent sees.</p>
${roots.map(sampleCard).join("")}

<h2>What the agent will see</h2>
<p class="sub">The view: ${num(view.parts.length)} lines, ${num(viewBytes)} bytes of a 128 KB budget. Old stretches are coarse, recent ones fine; each line can be zoomed back to its exact messages. Lines by level: ${[...viewLevels].sort((a, b) => b[0] - a[0]).map(([l, n]) => `L${l} ×${n}`).join(", ")}.</p>
<details><summary>Show the whole view</summary><div class="view">${viewLines.map(({ part, text }) => `<div><i>${num(start(part.l, part.i))}+${num(2 ** part.l)}</i> ${esc(flat(text))}</div>`).join("")}</div></details>

<h2>Samples: single messages</h2>
<p class="sub">Random long messages from each source, with what the compactor wrote for them. Open the original to compare.</p>
${leafSamples.map(sampleCard).join("")}

<h2>Samples: merged lines</h2>
<p class="sub">Random lines from levels ${mergeLevels.join(", ")}, each folding many messages into one.</p>
${mergeSamples.map(sampleCard).join("")}

<h2>Notes from the build</h2>
<ol class="notes">
	<li><b>Fixed a copied prompt example.</b> The first pilot showed the summarizer copying the prompt's sample summary into real summaries at every level. The sample is now a content-free 512-byte ruler; the checks above confirm none of it (or the retry marker) leaked into this build.</li>
	<li><b>Fixed two slowdowns.</b> At 86k messages the view did per-line database work on every change (calls slowed to 45 s), and later merges were starved by single-message summaries running ahead (calls swelled to 62k tokens). Both fixed; the memory code in the brain got the same improvements.</li>
	<li><b>Order follows time.</b> Coding sessions and Claude.ai conversations are interleaved by when each session started, so recent work stays finest in the view. ChatGPT will slot in by time when its export arrives, reusing every summary already made.</li>
	<li><b>Restarts:</b> the build was resumed ${restarts} time${restarts === 1 ? "" : "s"}; finished summaries are never redone.</li>
</ol>
<p class="sub" style="margin-top:28px">Database: ${esc(dbPath)} (${(statSync(dbPath).size / 1e6).toFixed(0)} MB) · log: ${esc(logPath)}</p>
</main></body></html>`;

writeFileSync(outPath, html, { mode: 0o600 });
console.log(`Report: ${outPath}`);
