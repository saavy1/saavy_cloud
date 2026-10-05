// The memory at a glance, for a front end's splash: how full the view is, how much was said each day, and what the
// most recent stretch was about. Computed where the memory lives, so a remote front end gets it in one call.
import type { Memory } from "./memory.ts";
import { VIEW } from "./view.ts";

const DAY = 86_400_000;

export interface Glance {
	readonly messages: number;
	readonly summaries: number;
	readonly viewBytes: number;
	readonly viewBudget: number;
	readonly depth: number;
	/** The newest built summary of up to 8 messages, flattened. */
	readonly recent?: string;
	/** Messages per local day, oldest first. */
	readonly days: readonly { readonly value: number; readonly label: string }[];
}

/** The summary of the most recent stretch: the newest built node of up to 8 messages, coarsest first. */
function lastTime(memory: Memory): string | undefined {
	const T = memory.log.length;
	for (const l of [3, 2, 1, 0]) {
		const width = 2 ** l;
		if (T < width) continue;
		const node = memory.tree.get(l, Math.floor(T / width) - 1);
		if (node !== undefined) return node.text.replace(/\s*\n\s*/g, " ");
	}
	return undefined;
}

/**
 * @param offsetMinutes the viewer's `Date.getTimezoneOffset()`, so days break at their midnight
 */
export function glance(memory: Memory, offsetMinutes = 0, days = 30): Glance {
	const offset = offsetMinutes * 60_000;
	const today = Math.floor((Date.now() - offset) / DAY);
	const first = today - (days - 1);
	const counts = new Array<number>(days).fill(0);
	for (const date of memory.log.store.logDates(first * DAY + offset)) {
		const day = Math.floor((date - offset) / DAY) - first;
		if (day >= 0 && day < days) counts[day]!++;
	}
	const label = (day: number) => new Date((first + day) * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	const recent = lastTime(memory);
	return {
		messages: memory.log.length,
		summaries: memory.tree.size,
		viewBytes: memory.view.size(),
		viewBudget: VIEW,
		depth: Math.max(0, ...memory.view.parts.map((part) => part.l)),
		...(recent === undefined ? {} : { recent }),
		days: counts.map((value, day) => ({ value, label: `${label(day)}: ${value}` })),
	};
}
