// The startup splash: one card at the top of the transcript with the memory at a glance (a shimmering name, how full
// the view is, how much was said each day, what the most recent stretch was about) and ways into it.

import type { Glance } from "../../core/glance.ts";

function greeting(now = new Date()): string {
	const hour = now.getHours();
	return hour < 5 ? "Up late." : hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
}

export function splashNode(id: string, glance: Glance, model: string): object {
	const T = glance.messages;
	const VIEW = glance.viewBudget;
	const fill = Math.min(1, glance.viewBytes / VIEW);
	const depth = glance.depth;
	const recent = glance.recent;
	const days = glance.days;
	const active = days.filter((day) => day.value > 0).length;
	return {
		id,
		k: "card",
		p: { role: "saavy.splash", tone: "accent" },
		c: [
			{
				id: `${id}.top`,
				k: "row",
				p: { gap: "md", align: "center" },
				c: [
					{ id: `${id}.name`, k: "shimmer", p: { text: "saavy", palette: { low: "muted", mid: "accent", high: "info" } } },
					{ id: `${id}.hi`, k: "text", p: { text: greeting(), tone: "muted" } },
					{ id: `${id}.gap`, k: "row", p: { grow: 1 }, c: [] },
					{ id: `${id}.model`, k: "text", p: { text: model, tone: "muted", wrap: "none" } },
				],
			},
			{
				id: `${id}.mem`,
				k: "meter",
				p: {
					value: fill,
					style: "bar",
					label: [{ t: `view ${Math.round(fill * 100)}%` }],
					total: [{ t: `of ${Math.round(VIEW / 1000)} KB · ${T} messages · ${glance.summaries} summaries · ${depth + 1} levels deep` }],
				},
			},
			...(T === 0
				? []
				: [
						{
							id: `${id}.days`,
							k: "chart",
							p: {
								kind: "bars",
								size: "sm",
								series: days,
								summary: [{ t: `messages per day, last 30 days · ${active} active day${active === 1 ? "" : "s"}`, s: "muted" }],
							},
						},
					]),
			...(recent === undefined
				? [{ id: `${id}.new`, k: "text", p: { text: "A blank slate. Everything said here is remembered, word for word.", tone: "muted" } }]
				: [{ id: `${id}.last`, k: "md", p: { text: `**Last time:** ${recent}` } }]),
			{
				id: `${id}.go`,
				k: "row",
				p: { gap: "sm" },
				c: [
					{ id: `${id}.explore`, k: "badge", p: { text: "Explore memory", tone: "accent", title: "Walk the summary tree  /memory", actions: { click: "explore" } } },
					{ id: `${id}.browse`, k: "badge", p: { text: "Browse", title: "The memory as a page  /browse", actions: { click: "browse" } } },
				],
			},
		],
	};
}
