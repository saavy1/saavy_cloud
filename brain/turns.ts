// The durable turn queue. A message is stored in the inbox before anything else happens; a Lifecycle job then waits
// for the view's summaries (spec §6), renders the view, resets the conversation, and submits, so a turn survives the
// brain being evicted at any step. The same queue drives the compactor.
//
// Jobs never block the alarm: one hung model call must not hold back every turn behind it. Like PiHarness, a job
// starts long work detached (tracked by Lifecycle) and comes back on a short reschedule, a heartbeat that also keeps
// the brain awake while the work runs.
import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { type LifecycleJobContext, type LifecycleJobOutcome, LifecycleCapability } from "agents/lifecycle";
import type { Memory } from "../core/memory.ts";
import { TurnDoc } from "./extension.ts";

/** How long a turn waits for the view's summaries before answering with placeholders. */
export const SETTLE_MS = 20_000;
/** How long one drive of the compactor keeps starting builds. */
const DRIVE_BUDGET_MS = 5 * 60_000;
/** Heartbeat while summaries are being built. */
const HEARTBEAT_MS = 20_000;

export interface TurnHost {
	readonly memory: Memory;
	readonly harness: PiHarness;
	root(): Promise<Conversation>;
	readonly context: Context;
}

interface Item {
	readonly id: string;
	readonly text: string;
}

export class Turns extends LifecycleCapability {
	readonly #sql: SqlStorage;
	readonly #host: () => TurnHost;
	/** The compactor drive in progress in this instance. */
	#drive: Promise<void> | undefined;
	/** When the waiting turn started waiting for summaries. */
	#settleSince: number | undefined;

	constructor(sql: SqlStorage, host: () => TurnHost) {
		super("saavy-turns");
		this.#sql = sql;
		this.#host = host;
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS saavy_inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS saavy_ops (item TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL);
		`);
	}

	/** Store a message for the next turn (or to steer the running one); its id, to wait on. */
	async enqueue(text: string): Promise<string> {
		const id = crypto.randomUUID();
		this.#sql.exec("INSERT INTO saavy_inbox (id, text, at) VALUES (?, ?, ?)", id, text, Date.now());
		await this.lifecycle.jobs.push({ id: "turn", fn: "turn", time: Date.now() });
		return id;
	}

	/** The pi operation a queued message went out as, once it has. */
	operation(item: string): string | undefined {
		const rows = this.#sql.exec("SELECT operation FROM saavy_ops WHERE item = ?", item).toArray();
		return rows.length === 0 ? undefined : String(rows[0]!.operation);
	}

	queued(): number {
		return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM saavy_inbox").one().n);
	}

	/** Make sure the compactor job is pending; cheap to call on every change. */
	async compact(): Promise<void> {
		if (this.lifecycle.jobs.get("compact") !== undefined) return;
		await this.lifecycle.jobs.push({ id: "compact", fn: "compact", time: Date.now() });
	}

	override onStart(): void {
		// A brain that wakes picks up summaries a previous instance left unbuilt.
		if (this.#host().memory.pending) void this.compact();
	}

	async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
		if (job.fn === "turn") return this.#turn();
		if (job.fn === "compact") return this.#compactBeat();
		return undefined;
	}

	/** Start a compactor drive unless one is running; Lifecycle tracks it so an alarm does not outlive it unseen. */
	#ensureDrive(budgetMs: number): void {
		if (this.#drive !== undefined) return;
		const drive: Promise<void> = this.#host()
			.memory.drive(budgetMs)
			.catch((error: unknown) => console.warn("compactor drive failed", error))
			.finally(() => {
				if (this.#drive === drive) this.#drive = undefined;
			});
		this.#drive = drive;
		this.lifecycle.trackAlarmWork(drive);
	}

	#items(): Item[] {
		return this.#sql
			.exec("SELECT id, text FROM saavy_inbox ORDER BY at, id")
			.toArray()
			.map((row) => ({ id: String(row.id), text: String(row.text) }));
	}

	/** Mark items sent as `operation`, and take them out of the inbox. */
	#sent(items: readonly Item[], operation: string): void {
		for (const item of items) {
			this.#sql.exec("INSERT OR REPLACE INTO saavy_ops (item, operation, at) VALUES (?, ?, ?)", item.id, operation, Date.now());
			this.#sql.exec("DELETE FROM saavy_inbox WHERE id = ?", item.id);
		}
		// Keep a day of operations for waiters.
		this.#sql.exec("DELETE FROM saavy_ops WHERE at < ?", Date.now() - 86_400_000);
	}

	async #turn(): Promise<LifecycleJobOutcome> {
		const host = this.#host();
		const items = this.#items();
		if (items.length === 0) return undefined;
		// A run in progress: new messages join it after the current tool round.
		if (await host.harness.session().busy()) {
			for (const item of items) {
				await host.harness.submit(item.text, { operationId: item.id, whenBusy: "steer" });
				this.#sent([item], item.id);
			}
			return undefined;
		}
		// The view covers everything before the new messages: give its lines (bounded) time to become summaries.
		if (host.memory.view.unbuilt() > 0) {
			this.#settleSince ??= Date.now();
			if (Date.now() - this.#settleSince < SETTLE_MS) {
				this.#ensureDrive(DRIVE_BUDGET_MS);
				void this.compact();
				return { rescheduleAt: Date.now() + 500 };
			}
			console.warn(`${host.memory.view.unbuilt()} summaries still pending; answering without them`);
		}
		this.#settleSince = undefined;
		const view = host.memory.view.render();
		const root = await host.root();
		await root.reset(undefined, host.context);
		await root.commit(async (tx) => {
			(await tx.doc(TurnDoc, root.id)).view = view;
		}, host.context);
		// Idempotent: a job rerun after an eviction resubmits the same operation, which pi deduplicates.
		const operation = `${items[0]!.id}:${items.length}`;
		await host.harness.submit(items.map((item) => item.text).join("\n\n"), { operationId: operation, whenBusy: "steer" });
		this.#sent(items, operation);
		// Messages that arrived meanwhile go next.
		return this.#items().length > 0 ? "yield" : undefined;
	}

	async #compactBeat(): Promise<LifecycleJobOutcome> {
		const { memory } = this.#host();
		if (!memory.pending && this.#drive === undefined) return undefined;
		this.#ensureDrive(DRIVE_BUDGET_MS);
		return { rescheduleAt: Date.now() + HEARTBEAT_MS };
	}
}
