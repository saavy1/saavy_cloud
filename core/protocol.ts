// The brain ⇄ runner wire: JSON text frames over one WebSocket the runner dials.
//
//   brain → runner   { id, op: "env", cwd, method, args, key? }   call one ExecutionEnv method on the runner's machine;
//                                                          with a key, a repeat of that key gets the first result
//                    { id, op: "cancel" }                   abort that call
//   runner → brain   { hello: { host, platform, home } }   once, on connect
//                    { id, output }                         shell output while an exec runs
//                    { id, result }                         the method's Result, as WireResult

/** ExecutionEnv methods the runner serves. */
export const ENV_METHODS = [
	"absolutePath",
	"joinPath",
	"readTextFile",
	"readTextLines",
	"readBinaryFile",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
	"exec",
] as const;
export type EnvMethod = (typeof ENV_METHODS)[number];

export interface WireError {
	readonly kind: "file" | "exec";
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export type WireResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: WireError };

export interface RunnerHello {
	readonly host: string;
	readonly platform: string;
	readonly home: string;
}

export type BrainFrame =
	| { readonly id: string; readonly op: "env"; readonly cwd: string; readonly method: EnvMethod; readonly args: unknown[]; readonly key?: string }
	| { readonly id: string; readonly op: "cancel" };

export type RunnerFrame = { readonly hello: RunnerHello } | { readonly id: string; readonly output: string } | { readonly id: string; readonly result: WireResult };

/** Bytes travel as { $bytes: base64 }; everything else is plain JSON. */
export function encodeValue(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		let binary = "";
		for (let n = 0; n < value.length; n += 0x8000) binary += String.fromCharCode(...value.subarray(n, n + 0x8000));
		return { $bytes: btoa(binary) };
	}
	return value;
}

export function decodeValue(value: unknown): unknown {
	if (typeof value === "object" && value !== null && typeof (value as { $bytes?: unknown }).$bytes === "string") {
		const binary = atob((value as { $bytes: string }).$bytes);
		const bytes = new Uint8Array(binary.length);
		for (let n = 0; n < binary.length; n++) bytes[n] = binary.charCodeAt(n);
		return bytes;
	}
	return value;
}

// The brain ⇄ client wire (front ends: Tern, pi-tui), JSON text frames over /ws/client.
//
//   client → brain   { t: "call", id, method, args }      one RPC (see ClientMethods in brain/clients.ts)
//   brain → client   { t: "reply", id, ok, value | error }
//                    { t: "entry", entry }                a committed entry of the main conversation
//                    { t: "view", docs, last }            pi's live docs (agent, usage, live), and the newest entry id
//                    { t: "phase", phase }                idle | settling | running
//                    { t: "memory", stats }               memory counters changed
//                    { t: "notice", level, message }

export type Phase = "idle" | "settling" | "running";

export interface MemoryStats {
	readonly messages: number;
	readonly summaries: number;
	readonly viewBytes: number;
	readonly viewLines: number;
	readonly depth: number;
	readonly unbuilt: number;
	readonly compacting: number;
}

/** A tree node or message as the explorer shows it. */
export interface NodeInfo {
	readonly l: number;
	readonly i: number;
	readonly text: string | null;
}

export interface MsgInfo {
	readonly i: number;
	readonly kind: string;
	readonly text: string;
	readonly date: number;
}

export type ClientFrame = { readonly t: "call"; readonly id: number; readonly method: string; readonly args: unknown[] };

export type ServerFrame =
	| { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: string }
	| { readonly t: "entry"; readonly entry: unknown }
	| { readonly t: "view"; readonly docs: Record<string, unknown>; readonly last: unknown }
	| { readonly t: "phase"; readonly phase: Phase }
	| { readonly t: "memory"; readonly stats: MemoryStats }
	| { readonly t: "notice"; readonly level: "info" | "warning" | "error"; readonly message: string };
