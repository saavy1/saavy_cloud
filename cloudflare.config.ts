import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./brain/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "saavy",
		entrypoint,
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		exports: { Brain: exports.durableObject({ storage: "sqlite" }) },
		env: {
			Brain: bindings.durableObject({ worker: "saavy", exportName: "Brain" }),
			AI: bindings.ai({ dev: { remote: true } }),
			// Shared by the runner and API clients for the spike; per-device tokens later.
			SAAVY_TOKEN: bindings.secret(),
			LOADER: bindings.workerLoader(),
		},
		observability: { enabled: true },
	},
});
