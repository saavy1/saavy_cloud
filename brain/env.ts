// The desktop as pi's ExecutionEnv: every filesystem and shell call goes to the runner over its socket and runs there
// on a real NodeExecutionEnv, so pi's own coding tools (read, write, edit, bash) work on the user's machine unchanged.
import type { Context } from "@earendil-works/chord";
import {
	type ExecutionEnv,
	ExecutionError,
	type ExecutionErrorCode,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { decodeValue, type EnvMethod, encodeValue, type WireResult } from "../core/protocol.ts";

/** Sends one call to the runner; resolves with its result, or an error result when no runner is connected. */
export type RunnerSend = (call: { cwd: string; method: EnvMethod; args: unknown[]; key?: string }, onOutput: ((text: string) => void) | undefined, signal: AbortSignal | undefined) => Promise<WireResult>;

export class RemoteEnv implements ExecutionEnv {
	/** One file namespace: the desktop. pi serializes mutations per namespace. */
	readonly id = "desktop";
	cwd: string;
	readonly #send: RunnerSend;
	/** Set for one tool task: its calls are keyed task:n, so a replay after an eviction gets the first results. */
	readonly #callId: string | undefined;
	#n = 0;

	constructor(cwd: string, send: RunnerSend, callId?: string) {
		this.cwd = cwd;
		this.#send = send;
		this.#callId = callId;
	}

	/** This env for one tool task (a unique id that survives replay), its desktop calls idempotent by key. */
	forCall(callId: string): RemoteEnv {
		return new RemoteEnv(this.cwd, this.#send, callId);
	}

	async #call<T>(method: EnvMethod, args: unknown[], context: Context, onOutput?: (text: string) => void): Promise<Result<T, never>> {
		const key = this.#callId === undefined ? undefined : `${this.#callId}:${this.#n++}`;
		const call = { cwd: this.cwd, method, args: args.map(encodeValue), ...(key === undefined ? {} : { key }) };
		const result = await this.#send(call, onOutput, context.abortSignal);
		if (result.ok) return { ok: true, value: decodeValue(result.value) as T };
		const { kind, code, message, path } = result.error;
		const error = kind === "exec" ? new ExecutionError(code as ExecutionErrorCode, message) : new FileError(code as FileErrorCode, message, path);
		return { ok: false, error: error as never };
	}

	absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#call("absolutePath", [path], context);
	}
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.#call("joinPath", [parts], context);
	}
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#call("readTextFile", [path], context);
	}
	/** Read once, then serve the lines locally: a reader is a round trip per line otherwise. */
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const pieces = text.value.split("\n");
		const lines = pieces.map((piece, n) => ({ text: piece, terminated: n < pieces.length - 1 }));
		if (lines.at(-1)?.text === "") lines.pop();
		let next = 0;
		return {
			ok: true,
			value: {
				readLine: async () => ({ ok: true, value: lines[next++] }),
				close: async () => {},
			},
		};
	}
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		return this.#call("readTextLines", [path, options], context);
	}
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#call("readBinaryFile", [path], context);
	}
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#call("writeFile", [path, content], context);
	}
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#call("appendFile", [path, content], context);
	}
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#call("truncateFile", [path, size], context);
	}
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#call("flushFile", [path], context);
	}
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.#call("renameFile", [sourcePath, destinationPath], context);
	}
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#call("fileInfo", [path], context);
	}
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#call("listDir", [path], context);
	}
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#call("canonicalPath", [path], context);
	}
	exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#call("exists", [path], context);
	}
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#call("createDir", [path, options], context);
	}
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#call("remove", [path, options], context);
	}
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#call("createTempDir", [prefix], context);
	}
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#call("createTempFile", [options], context);
	}
	exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const { onOutput, ...rest } = options ?? {};
		return this.#call("exec", [command, rest], context, onOutput === undefined ? undefined : (text) => onOutput(text, context));
	}
	async cleanup(): Promise<void> {}
}
