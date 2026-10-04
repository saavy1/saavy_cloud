// The desktop as a codemode connector: scripts the model writes run in a Dynamic Worker and reach the user's machine
// through the runner, as `desktop.read({ path })` and `desktop.bash({ command })`.
import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";

export type RunnerCall = (op: string, args: Record<string, unknown>) => Promise<string>;

export class DesktopConnector extends CodemodeConnector {
	readonly #call: RunnerCall;

	constructor(ctx: DurableObjectState, env: unknown, call: RunnerCall) {
		super(ctx, env);
		this.#call = call;
	}

	override name(): string {
		return "desktop";
	}

	protected override instructions(): string {
		return "The user's desktop, through their runner: read files and run bash there.";
	}

	protected override tools(): ConnectorTools {
		return {
			read: {
				description: "Read a text file on the desktop.",
				inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				// Reads are idempotent and can be large; re-run them on replay instead of logging them.
				replay: "reexecute",
				execute: (args) => this.#call("remote_read", args as Record<string, unknown>),
			},
			bash: {
				description: "Run a bash command on the desktop; resolves to stdout, stderr and the exit code.",
				inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				execute: (args) => this.#call("remote_bash", args as Record<string, unknown>),
			},
		};
	}
}
