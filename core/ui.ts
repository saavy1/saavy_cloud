// Generative UI: the agent describes UI once, as a tree of nodes ({ k, id?, p?, c? }, the Tern Surface Protocol's
// vocabulary), and every front end draws it as well as it can: Tern natively (tables, charts, checklists, forms with
// buttons that talk back), other terminals as text (toText), later clients their own way. The spec is declarative and
// safe (no scripts, no raw HTML, theme tokens instead of colors). It lives in the transcript as the show call's
// arguments, so any client, at any time, can draw it from history. This module is the shared part: kinds, checks,
// updates, the text rendering, and what the agent is told.

export interface UiNode {
	readonly k: string;
	readonly id?: string;
	readonly p?: Record<string, unknown>;
	readonly c?: readonly UiNode[];
}

/** What the agent may draw: content kinds only (no editors, pickers, overlays, or toasts, which belong to saavy). */
export const UI_KINDS = new Set([
	"col", "row", "card", "section", "rule", "text", "md", "code", "diff", "math", "kv", "table", "tree", "badge",
	"kbd", "icon", "spinner", "shimmer", "elapsed", "progress", "meter", "chart", "list", "item", "tabs", "checklist",
	"el", "rate",
]);

const MAX_NODES = 600;
const MAX_DEPTH = 16;
const MAX_CHARS = 120_000;

/** Why a spec is not drawable, or undefined when it is. */
export function checkUi(spec: unknown): string | undefined {
	const size = JSON.stringify(spec ?? null).length;
	if (size > MAX_CHARS) return `The UI is ${size} characters; the limit is ${MAX_CHARS}. Show less, or summarize.`;
	let count = 0;
	const ids = new Set<string>();
	const walk = (node: unknown, depth: number, path: string): string | undefined => {
		if (depth > MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH}`;
		if (typeof node !== "object" || node === null || Array.isArray(node)) return `${path}: a node must be an object { k, id?, p?, c? }`;
		const { k, id, p, c } = node as Record<string, unknown>;
		if (typeof k !== "string" || !UI_KINDS.has(k)) return `${path}: kind ${JSON.stringify(k)} is not drawable; use one of ${[...UI_KINDS].join(", ")}`;
		if (id !== undefined) {
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return `${path}: id must be 1-40 characters of [A-Za-z0-9_-]`;
			if (ids.has(id)) return `${path}: id "${id}" is used twice`;
			ids.add(id);
		}
		if (p !== undefined && (typeof p !== "object" || p === null || Array.isArray(p))) return `${path}: p must be an object of props`;
		if (++count > MAX_NODES) return `more than ${MAX_NODES} nodes`;
		if (c !== undefined) {
			if (!Array.isArray(c)) return `${path}: c must be an array of nodes`;
			for (const [n, child] of c.entries()) {
				const error = walk(child, depth + 1, `${path}.c[${n}]`);
				if (error !== undefined) return error;
			}
		}
		return undefined;
	};
	return walk(spec, 0, "ui");
}

export interface UiUpdate {
	/** Shallow prop changes, by the agent's node id. */
	readonly set?: readonly { id: string; props: Record<string, unknown> }[];
	/** Text appended to text-like nodes (md, text, code, ansi), by id. */
	readonly append?: readonly { id: string; text: string }[];
	/** A whole new tree in place of the old one. */
	readonly ui?: UiNode;
}

export function checkUpdate(update: UiUpdate): string | undefined {
	if (update.ui !== undefined) return checkUi(update.ui);
	if ((update.set?.length ?? 0) === 0 && (update.append?.length ?? 0) === 0) return "Give set, append, or ui.";
	return undefined;
}

/** The spec with an update applied (for text renderings, which redraw whole). */
export function applyUpdate(spec: UiNode, update: UiUpdate): UiNode {
	if (update.ui !== undefined) return update.ui;
	const set = new Map((update.set ?? []).map((entry) => [entry.id, entry.props]));
	const append = new Map((update.append ?? []).map((entry) => [entry.id, entry.text]));
	const walk = (node: UiNode): UiNode => {
		let p = node.p;
		if (node.id !== undefined && set.has(node.id)) p = { ...p, ...set.get(node.id) };
		if (node.id !== undefined && append.has(node.id)) p = { ...p, text: `${String(p?.text ?? "")}${append.get(node.id)}` };
		return { ...node, ...(p === undefined ? {} : { p }), ...(node.c === undefined ? {} : { c: node.c.map(walk) }) };
	};
	return walk(spec);
}

// ─── Text rendering (terminals without TSP) ───

const spanText = (value: unknown): string =>
	typeof value === "string"
		? value
		: Array.isArray(value)
			? value.map((span) => (typeof span === "string" ? span : String((span as { t?: unknown })?.t ?? ""))).join("")
			: value === undefined || value === null
				? ""
				: String(value);

/** Markdown approximating a UI spec. */
export function toText(node: UiNode, depth = 0): string {
	const p = node.p ?? {};
	const kids = (node.c ?? []).map((child) => toText(child, depth + 1)).filter((text) => text !== "");
	const bar = (value: number) => `${"█".repeat(Math.round(Math.max(0, Math.min(1, value)) * 20))}${"░".repeat(20 - Math.round(Math.max(0, Math.min(1, value)) * 20))}`;
	switch (node.k) {
		case "md":
		case "text":
		case "math":
			return spanText(p.spans ?? p.text);
		case "code":
			return `\`\`\`${String(p.lang ?? "")}\n${String(p.text ?? "")}\n\`\`\``;
		case "diff":
			return `\`\`\`diff\n${String(p.text ?? "")}\n\`\`\``;
		case "card":
		case "section":
			return [p.head === undefined ? "" : `**${spanText(p.head)}**`, ...kids].filter(Boolean).join("\n\n");
		case "rule":
			return `--- ${spanText(p.label)}`;
		case "kv":
			return ((p.items as { k: unknown; v: unknown }[] | undefined) ?? []).map((item) => `- **${spanText(item.k)}**: ${spanText(item.v)}`).join("\n");
		case "table": {
			const cols = (p.cols as { id: string; head?: unknown }[] | undefined) ?? [];
			const rows = (p.rows as { cells?: Record<string, unknown> }[] | undefined) ?? [];
			if (cols.length === 0) return "";
			const cell = (value: unknown) => {
				const meter = (value as { meter?: { value?: number } } | null)?.meter;
				return (meter !== undefined ? `${Math.round((meter.value ?? 0) * 100)}%` : spanText(value)).replace(/\|/g, "\\|");
			};
			return [
				`| ${cols.map((col) => spanText(col.head ?? col.id)).join(" | ")} |`,
				`| ${cols.map(() => "---").join(" | ")} |`,
				...rows.map((row) => `| ${cols.map((col) => cell(row.cells?.[col.id])).join(" | ")} |`),
			].join("\n");
		}
		case "chart": {
			const series = (p.series as { value?: number; label?: unknown }[] | undefined) ?? [];
			const max = Math.max(1, ...series.map((entry) => entry.value ?? 0));
			return [spanText(p.summary), ...series.map((entry) => `${bar((entry.value ?? 0) / max)} ${spanText(entry.label)} ${entry.value ?? 0}`)].filter(Boolean).join("\n");
		}
		case "meter":
		case "progress":
			return `${bar(Number(p.value ?? 0))} ${spanText(p.label) || `${Math.round(Number(p.value ?? 0) * 100)}%`}`;
		case "checklist": {
			const mark: Record<string, string> = { done: "[x]", active: "[>]", dropped: "[-]", blocked: "[!]" };
			return ((p.phases as { title?: unknown; items?: { text?: unknown; status?: string }[] }[] | undefined) ?? [])
				.map((phase) => [phase.title === undefined ? "" : `**${spanText(phase.title)}**`, ...(phase.items ?? []).map((item) => `${mark[item.status ?? ""] ?? "[ ]"} ${spanText(item.text)}`)].filter(Boolean).join("\n"))
				.join("\n\n");
		}
		case "list":
			return kids.map((kid) => `- ${kid}`).join("\n");
		case "item":
			return [spanText(p.label), spanText(p.detail)].filter(Boolean).join(" — ");
		case "badge":
			return `\`${spanText(p.text)}\``;
		case "tree": {
			const lines: string[] = [];
			const walk = (items: { label?: unknown; children?: unknown[] }[], level: number) => {
				for (const item of items) {
					lines.push(`${"  ".repeat(level)}- ${spanText(item.label)}`);
					walk((item.children as { label?: unknown; children?: unknown[] }[] | undefined) ?? [], level + 1);
				}
			};
			walk((p.nodes as { label?: unknown; children?: unknown[] }[] | undefined) ?? [], 0);
			return lines.join("\n");
		}
		case "el": {
			const tag = String(p.tag ?? "div");
			if (tag === "button") return `[${spanText(p.text)}] _(clickable in Tern)_`;
			if (tag === "input") return `${p.checked === true ? "[x]" : "[ ]"} ${String(p.value ?? "")}`;
			return [spanText(p.text), ...kids].filter(Boolean).join(tag === "span" ? " " : "\n");
		}
		default:
			return [spanText(p.text ?? p.label), ...kids].filter(Boolean).join("\n");
	}
}

// ─── What the model is told ───

export const SHOW_DESCRIPTION = `Show the user UI instead of (or beside) prose: tables, charts, checklists, key/value lists, trees, meters, diffs, and forms with buttons. It is drawn by whichever front end the user has open: natively in Tern, as text in other terminals, and possibly elsewhere later, so it must read well as text too (prefer tables, kv, checklists, md; give every chart or meter a label or summary with the numbers). Buttons and panels only work in rich clients; never make a UI the only way to do something. \`ui\` is one node { k, id?, p?, c? } (kind, your id, props, children). \`handle\` names it: show again with the same handle to replace it, update_ui to change parts of it live. Clicks on buttons (el tag "button" with p.actions {click:"<name>"}) and list items reach you as a message starting "[ui <handle>]", with the form's checkbox and radio values. Inline UIs sit in the transcript; placement "panel" (a hint: clients without panes draw it inline) opens a pane beside the chat that stays in view while you keep talking (dashboards, live progress, anything large or long-lived); a side panel is half the width, so use "panel-down" for wide tables, or fewer columns. Keep it purposeful. Kinds and their main props (ui_reference(kind) for the rest):
- layout: col/row {gap:"sm"|"md", align, justify}; card {head, tone, collapsible, collapsed}; section {head, collapsible}; rule {label}
- text: md {text} (GFM, tables, mermaid); text {text|spans}; code {text, lang}; diff {text: unified diff}; math {text}
- data: kv {items:[{k,v}]}; table {cols:[{id,head,align}], rows:[{id,cells:{<colId>:value}}]}; tree {nodes:[{id,label,open,children}]}; list {selected} of item {label, detail, icon}; badge {text, tone}
- charts: chart {kind:"bars"|"spark"|"heatmap", series:[{value,label}], summary}; meter {value 0-1, style:"bar"|"ring"|"blocks", label}; progress {value|null, label}
- work: checklist {phases:[{id,title,items:[{id,text,status:"pending"|"active"|"done"|"dropped"|"blocked",note}]}]}; spinner {label}; elapsed {age: ms}
- forms: el {tag:"form"|"label"|"button"|"input"|"div"|"span"|..., text}; input {type:"checkbox"|"radio", name, value, checked}
Spans: [{t:"text", s:"muted"|"strong"|"accent"|"success"|"warning"|"error"|"code"|"path"}]. Tones: neutral, accent, info, success, warning, error, muted. No colors, scripts or HTML strings.`;

export const UPDATE_DESCRIPTION =
	"Change a UI you showed, live: set (props by your node ids, shallow-merged), append (text added to md/text/code nodes by id), or ui (a whole new tree). For progress during long work: tick checklist items, move meters, add rows.";

/** Details per kind, for ui_reference. */
export const UI_REFERENCE: Record<string, string> = {
	col: "col {gap:\"none\"|\"xs\"|\"sm\"|\"md\"|\"lg\", align, justify:\"between\"|\"end\", wrap} with children: a vertical stack. Most UIs have a col at the root.",
	row: "row {gap, align:\"start\"|\"center\"|\"end\", justify:\"between\"|\"end\", wrap} with children side by side; a child row {grow:1} with no children is a spacer. Any node takes grow, shrink, basis, min:{w,h}, max:{w,h} (\"Nch\", \"Nlines\" or a fraction, never pixels).",
	section: "section {head, collapsible, collapsed, key} with children: a foldable group, lighter than a card.",
	rule: "rule {label}: a hairline divider with an optional label.",
	text: "text {text} or {spans:[{t, s}]}, plus wrap:\"word\"|\"char\"|\"none\", truncate:\"end\"|\"start\"|\"middle\", lines. Only text (not spans) can be appended to with update_ui.",
	table: "table {cols:[{id, head, align:\"start\"|\"center\"|\"end\", truncate:\"end\"|\"start\"|\"middle\", priority, grow}], rows:[{id, cells:{<colId>: text | spans | {meter:{value, label}}}}]}. Rows are data, not clickable; put clickable things in a list of items.",
	chart: "chart {kind:\"bars\"|\"spark\"|\"heatmap\", size:\"sm\"|\"md\"|\"lg\", token (color token), summary (spans), series:[{value, label, title}] for bars/spark, cells:[[0..1]] rows of columns + rows (labels) + cols:[{at,label}] + tips for heatmap}.",
	meter: "meter {value 0-1, style:\"bar\"|\"ring\"|\"blocks\", size:\"sm\"|\"md\"|\"lg\", steps (blocks), parts:[{value, token, label}], thresholds:{warn, bad}, label, total, tone, marks:[{at, tone, title}]}.",
	checklist: "checklist {phases:[{id, title, collapsed, items:[{id, text, status:\"pending\"|\"active\"|\"done\"|\"dropped\"|\"blocked\", note}]}], mode:\"full\"|\"hud\"|\"reminder\", note}. Update items' statuses with update_ui set on the checklist's id (send all phases again).",
	tree: "tree {nodes:[{id, label, icon, open, children:[...]}]}. Only chevrons toggle; labels are not clickable.",
	list: "list {selected: item id, filter, empty, max} with item children {label, detail, value, icon, hint, disabled, tone}. Clicking an item reaches you as \"[ui <handle>] select <item id>\".",
	kv: "kv {items:[{k, v}], layout:\"inline\"}.",
	card: "card {head (text or spans), status:\"pending\"|\"running\"|\"done\"|\"error\"|\"cancelled\", tone, collapsible, collapsed, preview:{lines}} with children.",
	el: "el {tag, text, class, attrs} with children. Tags: div span p section header footer nav aside main article figure blockquote ul ol li dl dt dd h1-h4 pre code kbd strong em b i del mark hr table thead tbody tr th td label button form input. input: {type:\"checkbox\"|\"radio\", name, value, checked, disabled}. button: {text, actions:{click:\"<action name>\"}}; a click sends you the action with the values of the form's inputs.",
	md: "md {text}: GitHub-flavored markdown: tables, task lists, callouts, math, mermaid diagrams, fenced code. Raw HTML stays literal.",
	code: "code {text, lang, path (header), numbers (line numbers), start, marks:[{line, tone}], wrap}.",
	progress: "progress {value 0-1 or null (indeterminate), label}.",
	badge: "badge {text, tone, title}.",
	spinner: "spinner {style:\"braille\"|\"dots\"|\"orbit\", label (spans), tone}.",
	tabs: "tabs {items:[{id, label}], active: id}. Clicking a tab reaches you as an action.",
	diff: "diff {text: unified diff, path, lang, mode:\"unified\"|\"split\"|\"auto\"}; put it in a card whose head names the file.",
};
