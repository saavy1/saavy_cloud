import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./brain/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "saavy",
		entrypoint,
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		exports: { Brain: exports.durableObject({ storage: "sqlite" }) },
		// Only through agent.saavylab.dev: no workers.dev address or preview URLs to probe.
		workersDev: false,
		previewUrls: false,
		// agent.saavylab.dev: the zone's proxied wildcard record already covers it, so a route is all it takes.
		triggers: [triggers.fetch({ pattern: "agent.saavylab.dev/*", zone: "saavylab.dev" })],
		env: {
			Brain: bindings.durableObject({ worker: "saavy", exportName: "Brain" }),
			AI: bindings.ai({ dev: { remote: true } }),
			LOADER: bindings.workerLoader(),
			// Sign-in: better-auth with GitHub (allowlisted accounts only) and device codes for the CLI.
			DB: bindings.d1({ id: "015bf88a-046b-492e-9bda-16cdf321aacc", name: "saavy-auth" }),
			PUBLIC_URL: bindings.text("https://agent.saavylab.dev"),
			/** GitHub account ids (numbers, comma-separated) that may sign in. */
			ALLOWED_GITHUB_IDS: bindings.text("31431014"),
			BETTER_AUTH_SECRET: bindings.secret(),
			GITHUB_CLIENT_ID: bindings.secret(),
			GITHUB_CLIENT_SECRET: bindings.secret(),
		},
		observability: { enabled: true },
	},
});
