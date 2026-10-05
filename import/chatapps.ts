// Chat apps, from their data exports (unpacked under ~/.saavy/import/exports): Claude.ai and ChatGPT. Less code, more
// of the user: preferences, projects, people, decisions. Conversations become sessions like the coding agents'; what
// the apps remembered about the user (Claude's memory, its projects' instructions) becomes dated notes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cap } from "../core/log.ts";
import type { Kind } from "../core/store.ts";
import type { ImportMessage, ImportSession } from "./sources.ts";

export const EXPORTS = join(homedir(), ".saavy", "import", "exports");

const toMs = (t: unknown): number | undefined => {
	if (typeof t === "number") return t < 1e11 ? t * 1000 : t;
	if (typeof t === "string") {
		const ms = Date.parse(t);
		return Number.isNaN(ms) ? undefined : ms;
	}
	return undefined;
};

const json = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined);

function session(source: string, id: string, title: string | undefined, cwd: string, messages: ImportMessage[]): ImportSession[] {
	const kept = messages.filter((message) => message.text.trim() !== "");
	if (kept.length === 0) return [];
	kept.sort((a, b) => a.date - b.date);
	return [{ source, id, start: kept[0]!.date, cwd, ...(title ? { title } : {}), messages: kept }];
}

// ─── Claude.ai ───

interface ClaudeBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
	content?: { type?: string; text?: string }[];
	is_error?: boolean;
	start_timestamp?: string;
}

interface ClaudeMessage {
	uuid: string;
	sender: "human" | "assistant";
	text?: string;
	content?: ClaudeBlock[];
	created_at: string;
	attachments?: { file_name?: string; extracted_content?: string }[];
}

function claudeConversations(dir: string): ImportSession[] {
	const conversations = json<{ uuid: string; name?: string; chat_messages: ClaudeMessage[] }[]>(join(dir, "conversations", "conversations.json")) ?? [];
	return conversations.flatMap((conversation) => {
		const messages: ImportMessage[] = [];
		const push = (kind: Kind, text: string, date: number | undefined, record: string) => {
			if (date !== undefined) messages.push({ kind, text: kind === "echo" ? cap(text) : text, date, key: `claude.ai:${conversation.uuid}:${record}` });
		};
		for (const message of conversation.chat_messages) {
			const date = toMs(message.created_at);
			if (message.sender === "human") {
				const blocks = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "");
				const attachments = (message.attachments ?? []).map((file) => `[attachment ${file.file_name ?? ""}]\n${cap(file.extracted_content ?? "")}`);
				push("user", [...(blocks.length > 0 ? blocks : [message.text ?? ""]), ...attachments].join("\n\n"), date, message.uuid);
				continue;
			}
			(message.content ?? []).forEach((block, n) => {
				const at = toMs(block.start_timestamp) ?? date;
				if (block.type === "text") push("talk", block.text ?? "", at, `${message.uuid}:${n}`);
				else if (block.type === "tool_use") push("tool", `${block.name ?? "tool"} ${JSON.stringify(block.input ?? {})}`, at, `${message.uuid}:${n}`);
				else if (block.type === "tool_result") {
					const text = (block.content ?? []).map((part) => part.text ?? "").join("\n");
					push("echo", block.is_error ? `error: ${text}` : text, at, `${message.uuid}:${n}`);
				}
			});
		}
		return session("claude.ai", conversation.uuid, conversation.name, "(claude.ai)", messages);
	});
}

/** What Claude.ai remembered (the memory about the user, its memory files) and the user's projects there. */
function claudeContext(dir: string): ImportSession[] {
	const projects = readdirSync(join(dir, "projects", "projects"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => json<{ uuid: string; name: string; description?: string; prompt_template?: string; created_at: string; docs?: { filename: string; content: string; created_at: string }[] }>(join(dir, "projects", "projects", entry.name))!);
	const names = new Map(projects.map((project) => [project.uuid, project.name]));
	const out = projects.flatMap((project) => {
		const date = toMs(project.created_at)!;
		const key = (record: string) => `claude.ai-project:${project.uuid}:${record}`;
		const messages: ImportMessage[] = [
			{ kind: "note", text: `[Claude.ai project "${project.name}"] ${project.description ?? ""}${project.prompt_template ? `\nInstructions: ${project.prompt_template}` : ""}`, date, key: key("project") },
			...(project.docs ?? []).map((doc) => ({ kind: "note" as const, text: `[project document ${doc.filename}]\n${cap(doc.content)}`, date: toMs(doc.created_at) ?? date, key: key(doc.filename) })),
		];
		return session("claude.ai", `project-${project.uuid}`, `project: ${project.name}`, "(claude.ai)", messages);
	});
	const memoryDir = join(dir, "memories", "memories");
	for (const file of existsSync(memoryDir) ? readdirSync(memoryDir) : []) {
		const memory = json<{ conversations_memory?: string; project_memories?: Record<string, string>; memory_files?: { path: string; content: string; updated_at: string }[] }>(join(memoryDir, file));
		if (memory === undefined) continue;
		const files = memory.memory_files ?? [];
		const latest = Math.max(0, ...files.map((entry) => toMs(entry.updated_at) ?? 0));
		const date = latest || Date.now();
		const messages: ImportMessage[] = [
			...(memory.conversations_memory ? [{ kind: "note" as const, text: `[What Claude.ai remembered about the user]\n${memory.conversations_memory}`, date, key: "claude.ai-memory:profile" }] : []),
			...Object.entries(memory.project_memories ?? {}).map(([project, text]) => ({ kind: "note" as const, text: `[What Claude.ai remembered in project "${names.get(project) ?? project}"]\n${text}`, date, key: `claude.ai-memory:project:${project}` })),
			...files.map((entry) => ({ kind: "note" as const, text: `[Claude.ai memory file ${entry.path}]\n${cap(entry.content)}`, date: toMs(entry.updated_at) ?? date, key: `claude.ai-memory:file:${entry.path}` })),
		];
		out.push(...session("claude.ai", "memory", "what Claude.ai remembered", "(claude.ai)", messages));
	}
	return out;
}

// ─── ChatGPT ───

interface GptNode {
	id: string;
	parent?: string | null;
	message?: {
		id: string;
		author: { role: string; name?: string | null };
		create_time?: number | null;
		content: { content_type: string; parts?: unknown[]; text?: string; language?: string };
		recipient?: string;
		metadata?: { is_visually_hidden_from_conversation?: boolean };
	} | null;
}

const gptText = (content: NonNullable<GptNode["message"]>["content"]): string => {
	if (typeof content.text === "string") return content.text;
	return (content.parts ?? []).map((part) => (typeof part === "string" ? part : (part as { content_type?: string })?.content_type?.includes("image") ? "[image]" : "")).join("\n");
};

/** Each conversation along the branch the user ended on (edits and regenerations leave side branches). */
function chatgptConversations(dir: string): ImportSession[] {
	const conversations = json<{ id?: string; conversation_id?: string; title?: string; create_time?: number; mapping: Record<string, GptNode>; current_node?: string }[]>(join(dir, "conversations.json")) ?? [];
	return conversations.flatMap((conversation) => {
		const id = conversation.conversation_id ?? conversation.id ?? String(conversation.create_time);
		const path: GptNode[] = [];
		for (let node = conversation.current_node ? conversation.mapping[conversation.current_node] : undefined; node !== undefined; node = node.parent ? conversation.mapping[node.parent] : undefined) path.unshift(node);
		const messages: ImportMessage[] = [];
		let last = toMs(conversation.create_time) ?? 0;
		for (const node of path) {
			const message = node.message;
			if (!message || message.metadata?.is_visually_hidden_from_conversation) continue;
			const type = message.content.content_type;
			if (type === "thoughts" || type === "reasoning_recap" || type === "user_editable_context" || type === "model_editable_context") continue;
			const date = toMs(message.create_time) ?? last;
			last = date;
			const text = gptText(message.content);
			const key = `chatgpt:${id}:${message.id}`;
			const role = message.author.role;
			if (role === "user") messages.push({ kind: "user", text, date, key });
			else if (role === "assistant" && (message.recipient ?? "all") === "all") messages.push({ kind: "talk", text, date, key });
			else if (role === "assistant") messages.push({ kind: "tool", text: `${message.recipient} ${text}`, date, key });
			else if (role === "tool") messages.push({ kind: "echo", text: cap(`${message.author.name ? `${message.author.name}: ` : ""}${text}`), date, key });
		}
		return session("chatgpt", id, conversation.title, "(chatgpt)", messages);
	});
}

/** Every chat-app export present. */
export function chatAppSessions(): ImportSession[] {
	const claude = join(EXPORTS, "claude");
	const chatgpt = join(EXPORTS, "chatgpt");
	return [
		...(existsSync(join(claude, "conversations")) ? [...claudeConversations(claude), ...claudeContext(claude)] : []),
		...(existsSync(join(chatgpt, "conversations.json")) ? chatgptConversations(chatgpt) : []),
	];
}
