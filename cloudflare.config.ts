import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "saavy-spike",
		entrypoint,
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		exports: { Brain: exports.durableObject({ storage: "sqlite" }) },
		env: {
			Brain: bindings.durableObject({ worker: "saavy-spike", exportName: "Brain" }),
			AI: bindings.ai({ dev: { remote: true } }),
			// Shared by the runner and API clients for the spike; per-device tokens later.
			SAAVY_TOKEN: bindings.secret(),
			LOADER: bindings.workerLoader(),
		},
		observability: { enabled: true },
	},
});
