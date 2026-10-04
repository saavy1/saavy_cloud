// Phase-0 spike runner: dials out to the brain, runs what it asks on this machine, and answers.
//   SAAVY_URL=wss://…/ws/runner SAAVY_TOKEN=… node runner/runner.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const url = `${process.env.SAAVY_URL}?token=${encodeURIComponent(process.env.SAAVY_TOKEN ?? "")}`;

function connect(): void {
	const socket = new WebSocket(url);
	socket.addEventListener("open", () => console.log("runner connected"));
	socket.addEventListener("message", async (event) => {
		const { id, op, args } = JSON.parse(String(event.data)) as { id: string; op: string; args: Record<string, string> };
		if (typeof id !== "string" || typeof op !== "string") return;
		console.log(`${op} ${JSON.stringify(args)}`);
		try {
			let result: string;
			if (op === "remote_read") result = await readFile(args.path!, "utf8");
			else if (op === "remote_bash") {
				result = await new Promise((done) =>
					execFile("bash", ["-c", args.command!], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
						done(`${stdout}${stderr}\n(exit ${error === null ? 0 : (error as { code?: number }).code ?? 1})`),
					),
				);
			} else throw new Error(`unknown op ${op}`);
			socket.send(JSON.stringify({ id, ok: true, result }));
		} catch (error) {
			socket.send(JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
		}
	});
	socket.addEventListener("close", () => {
		console.log("runner disconnected; retrying in 2 s");
		setTimeout(connect, 2000);
	});
	socket.addEventListener("error", () => {});
}
connect();
