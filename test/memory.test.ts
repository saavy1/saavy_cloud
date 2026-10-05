import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { bytes, CAP, Log, messagesOf } from "../core/log.ts";
import { cutBytes, Memory, NODE } from "../core/memory.ts";
import { SCALE } from "../core/prompts.ts";
import { MemStore } from "../core/store.ts";
import { Tree } from "../core/tree.ts";
import { View } from "../core/view.ts";

let entryCount = 0;
const userEntry = (text: string): EntryRecord =>
	({
		id: ++entryCount,
		conversationId: "root",
		kind: "pi.user",
		model: [{ role: "user", content: text, timestamp: 1_700_000_000_000 }],
	}) as unknown as EntryRecord;

/** A fake compactor: answers with `reply(prompt)`; records every request. */
function fakeModels(reply: (messages: Message[]) => string) {
	const calls: Message[][] = [];
	const models = {
		streamSimple: (_model: unknown, context: { messages: Message[] }) => ({
			result: async (): Promise<AssistantMessage> => {
				calls.push(context.messages);
				return { role: "assistant", content: [{ type: "text", text: reply(context.messages) }], stopReason: "stop" } as AssistantMessage;
			},
		}),
	} as unknown as Models;
	return { models, calls };
}

const compactor = (models: Models) => ({ models, current: () => ({ model: {} as never, thinking: "off" as const }) });
const idle = () => new Promise((resolve) => setTimeout(resolve, 20));
const stepOf = (messages: Message[]) => {
	const content = messages.find((m) => m.role === "user")!.content;
	return typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("|");
};

test("SCALE is exactly NODE bytes", () => {
	assert.equal(bytes(SCALE), NODE);
});

test("messagesOf splits assistant turns, drops thoughts, caps echoes", () => {
	const assistant = {
		id: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				stopReason: "toolUse",
				timestamp: 5,
				content: [
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "looking" },
					{ type: "toolCall", id: "t", name: "read", arguments: { path: "a" } },
				],
			},
		],
	} as unknown as EntryRecord;
	assert.deepEqual(
		messagesOf(assistant).map((m) => [m.kind, m.text]),
		[
			["talk", "looking"],
			["tool", 'read {"path":"a"}'],
		],
	);
	const echo = { id: 2, kind: "pi.tool-result", model: [{ role: "toolResult", content: [{ type: "text", text: "x".repeat(CAP + 10) }], isError: false, timestamp: 6 }] } as unknown as EntryRecord;
	assert.match(messagesOf(echo)[0]!.text, /characters cut/);
});

test("cutBytes never splits a UTF-8 character", () => {
	assert.equal(cutBytes("aé", 2), "a");
	assert.equal(cutBytes("aé", 3), "aé");
});

test("the log skips entries it already has", () => {
	const log = new Log(new MemStore());
	const entry = userEntry("once");
	log.add(entry);
	log.add(entry);
	assert.equal(log.length, 1);
});

test("compactor builds level 0 in order, then merges; a new Memory over the same store resumes", async () => {
	const store = new MemStore();
	const { models, calls } = fakeModels((messages) => (stepOf(messages).includes("Merge these two lines") ? `merged ${calls.length}` : `summary ${calls.length}`));
	const memory = new Memory(store, compactor(models));
	for (let n = 0; n < 8; n++) memory.log.add(userEntry(n % 2 === 0 ? `long ${n} ${"z".repeat(600)}` : `short ${n}`));
	assert.equal(await memory.settle(), true);
	await idle();
	for (let i = 0; i < 8; i++) assert.ok(memory.tree.has(0, i), `node 0:${i}`);
	assert.equal(memory.tree.get(0, 1)!.text, "user: short 1");
	for (const call of calls) assert.doesNotMatch(stepOf(call), /not summarized yet/);
	assert.ok(memory.tree.has(1, 0) && memory.tree.has(2, 0) && memory.tree.has(3, 0));
	assert.equal(memory.zoom(0, 1), `0+0|user: long 0 ${"z".repeat(600)}`);
	assert.match(memory.zoom(0, 8), /^0\+4\|.*\n4\+4\|/);
	assert.equal(memory.zoom(3, 2), "No line 3+2.");
	memory.close();

	const again = new Memory(store, compactor(models));
	assert.equal(again.view.render(), memory.view.render());
	assert.equal(again.tree.size, memory.tree.size);
	again.close();
});

test("an over-long reply is retried with the cut shown, and the shortest try kept", async () => {
	const replies = ["y".repeat(700), "y".repeat(600), "short enough"];
	const { models, calls } = fakeModels(() => replies.shift()!);
	const memory = new Memory(new MemStore(), compactor(models));
	memory.log.add(userEntry("q".repeat(900)));
	await memory.settle();
	assert.equal(memory.tree.get(0, 0)!.text, "short enough");
	const feedback = calls[1]!.at(-1)!;
	assert.match(String(feedback.content), /That line is 700 bytes; the limit is 512/);
	assert.match(String(feedback.content), /\| ← LIMIT$/);
	memory.close();
});

test("the view appends at the end and merges the most due pair, never splitting; a saved view resumes identically", () => {
	const store = new MemStore();
	const log = new Log(store);
	const tree = new Tree(store);
	const view = new View(tree, log, store, 400);
	const line = (l: number, i: number) => tree.put({ l, i, text: `n${l}.${i} ${"w".repeat(40)}`, size: 0, key: "" });
	const snapshots: string[] = [];
	for (let i = 0; i < 64; i++) {
		log.add(userEntry(`m${i}`));
		line(0, i);
		for (let l = 1; (i + 1) % 2 ** l === 0; l++) line(l, (i + 1) / 2 ** l - 1);
		view.append(i);
		snapshots.push(view.render());
		assert.ok(view.size() <= 400, `size ${view.size()} at ${i}`);
		let next = 0;
		for (const part of view.parts) {
			assert.equal(part.i * 2 ** part.l, next);
			next += 2 ** part.l;
		}
		assert.equal(next, i + 1);
	}
	assert.ok(view.parts[0]!.l > view.parts.at(-1)!.l);
	const a = snapshots[62]!;
	const b = snapshots[63]!;
	let shared = 0;
	while (shared < a.length && a[shared] === b[shared]) shared++;
	assert.ok(shared > a.length / 3, `shared ${shared} of ${a.length}`);

	// Resumed from the saved parts, with messages logged since folded in, it matches folding from message 0.
	for (let i = 64; i < 70; i++) {
		log.add(userEntry(`m${i}`));
		line(0, i);
		for (let l = 1; (i + 1) % 2 ** l === 0; l++) line(l, (i + 1) / 2 ** l - 1);
	}
	const resumed = new View(tree, log, store, 400);
	const fresh = new MemStore();
	const refold = new View(tree, log, fresh, 400);
	assert.equal(resumed.render(), refold.render());
});

test("search finds every word verbatim, best and newest first, with ids to zoom", () => {
	const { models } = fakeModels(() => "x");
	const memory = new Memory(new MemStore(), compactor(models));
	memory.log.add(userEntry("the staging database password rotates monthly"));
	memory.log.add(userEntry("deploy to staging, then prod"));
	memory.log.add(userEntry("Staging staging staging database"));
	memory.log.add(userEntry("unrelated"));
	const result = memory.search("staging database");
	assert.deepEqual(result.split("\n").map((line) => Number(line.split("+")[0])), [2, 0]);
	assert.match(result, /^2\+0\|user: Staging staging/);
	assert.match(memory.search("nothing like this"), /^No message/);
	assert.match(memory.search("staging", { limit: 1 }), /2 more/);
	assert.match(memory.search("staging", { kind: "talk" }), /^No message/);
	memory.close();
});

test("settle gives up after its deadline when the compactor is stuck", async () => {
	const models = { streamSimple: () => ({ result: () => new Promise(() => {}) }) } as unknown as Models;
	const memory = new Memory(new MemStore(), compactor(models));
	memory.log.add(userEntry("z".repeat(900)));
	const started = Date.now();
	assert.equal(await memory.settle(undefined, 150), "late");
	assert.ok(Date.now() - started < 1000);
	const abort = new AbortController();
	const pending = memory.settle(abort.signal, 10_000);
	abort.abort();
	assert.equal(await pending, false);
	memory.close();
});

test("a driven memory builds only inside drive(), which resolves once nothing is running", async () => {
	const { models, calls } = fakeModels(() => "summary");
	const memory = new Memory(new MemStore(), { ...compactor(models), driven: true });
	for (let n = 0; n < 4; n++) memory.log.add(userEntry(`long ${n} ${"z".repeat(600)}`));
	await idle();
	assert.equal(calls.length, 0);
	assert.equal(memory.pending, true);
	await memory.drive(10_000);
	assert.equal(memory.running, 0);
	assert.equal(memory.view.unbuilt(), 0);
	assert.ok(memory.tree.has(2, 0));
	memory.close();
});
