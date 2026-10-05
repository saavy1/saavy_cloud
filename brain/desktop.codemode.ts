// The desktop as a codemode connector: scripts the model writes run in a Dynamic Worker and reach the user's machine
// through the runner, as `desktop.read({ path })` and `desktop.bash({ command })`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export class DesktopConnector extends CodemodeConnector {
	readonly #env: () => ExecutionEnv;

	constructor(ctx: DurableObjectState, env: unknown, desktop: () => ExecutionEnv) {
		super(ctx, env);
		this.#env = desktop;
	}

	override name(): string {
		return "desktop";
	}

	protected override instructions(): string {
		return "The user's desktop, through their runner: read files and run bash there, in the agent's working directory.";
	}

	protected override tools(): ConnectorTools {
		return {
			read: {
				description: "Read a text file on the desktop.",
				inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				// Reads are idempotent and can be large; re-run them on replay instead of logging them.
				replay: "reexecute",
				execute: async (args) => {
					const result = await this.#env().readTextFile((args as { path: string }).path, BACKGROUND_CONTEXT);
					if (!result.ok) throw result.error;
					return result.value;
				},
			},
			bash: {
				description: "Run a bash command on the desktop; resolves to its combined stdout and stderr, then the exit code.",
				inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				execute: async (args) => {
					let output = "";
					const options = { timeout: 120, onOutput: (text: string) => void (output += text) };
					const result = await this.#env().exec((args as { command: string }).command, options, BACKGROUND_CONTEXT);
					if (!result.ok) throw result.error;
					return `${output}\n(exit ${result.value.exitCode})`;
				},
			},
		};
	}
}
