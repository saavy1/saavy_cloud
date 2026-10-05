// saavy, the front end: connects to the brain on Cloudflare, runs the desktop runner while it is open (so the agent's
// tools act on this machine), and draws the chat: natively in Tern, with pi-tui in any other terminal.
//
//   saavy auth login | logout | status     sign this device in (device code, approved in the browser)
//   saavy                                  the chat (needs a signed-in device)
//   --no-runner   draw only; another runner (or none) serves the tools
// A standalone runner on this machine (the saavy-runner service) already serves them; then none is started here.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startRunner } from "../runner/link.ts";
import { authCommand, readCredentials } from "./auth.ts";
import { RemoteSaavy } from "./remote.ts";
import { handshake, tspWanted } from "./tsp/surface.ts";

if (process.argv[2] === "auth") process.exit(await authCommand(process.argv.slice(3)));

const { url, token } = readCredentials();
if (token === undefined) {
	console.error(`saavy: not signed in to ${url}. Run: saavy auth login`);
	process.exit(2);
}
const home = process.env.SAAVY_CLIENT_HOME ?? join(homedir(), ".saavy", "cloud");
mkdirSync(home, { recursive: true, mode: 0o700 });

/** Whether the standalone runner (runner/runner.ts, which leaves its pid) is running on this machine. */
function standaloneRunner(): boolean {
	try {
		const pid = Number(readFileSync(join(homedir(), ".saavy", "runner.pid"), "utf8"));
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const runner = process.argv.includes("--no-runner") || standaloneRunner() ? undefined : startRunner({ url, token });

let saavy: RemoteSaavy;
try {
	saavy = await RemoteSaavy.connect(url, token, home);
} catch (error) {
	console.error(`saavy: ${error instanceof Error ? error.message : String(error)}`);
	runner?.stop();
	process.exit(1);
}

try {
	const shake = tspWanted() ? await handshake(["edit"]) : undefined;
	// In Tern, draw natively over the Tern Surface Protocol; elsewhere (or if the handshake fails), pi-tui.
	if (shake?.hello !== undefined) {
		const { runTsp } = await import("./tsp/app.ts");
		await runTsp(saavy, shake);
	} else {
		const { runTui } = await import("./tui.ts");
		await runTui(saavy);
	}
} finally {
	if (saavy.phase !== "idle") console.log("The brain keeps working; reopen saavy to follow along.");
	saavy.close();
	runner?.stop();
}
process.exit(0);
