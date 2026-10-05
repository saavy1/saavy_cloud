// saavy, the front end: connects to the brain on Cloudflare, runs the desktop runner while it is open (so the agent's
// tools act on this machine), and draws the chat: natively in Tern, with pi-tui in any other terminal.
//
//   SAAVY_URL=https://… SAAVY_TOKEN=… node client/main.ts      (or ~/.config/saavy/cloud.json: { "url", "token" })
//   --no-runner   draw only; another runner (or none) serves the tools
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startRunner } from "../runner/link.ts";
import { RemoteSaavy } from "./remote.ts";
import { handshake, tspWanted } from "./tsp/surface.ts";

function settings(): { url: string; token: string } {
	const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "saavy", "cloud.json");
	const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string }) : {};
	const url = process.env.SAAVY_URL ?? saved.url;
	const token = process.env.SAAVY_TOKEN ?? saved.token;
	if (url === undefined || token === undefined) {
		console.error(`saavy: set SAAVY_URL and SAAVY_TOKEN, or write { "url", "token" } to ${file}`);
		process.exit(2);
	}
	return { url, token };
}

const { url, token } = settings();
const home = process.env.SAAVY_CLIENT_HOME ?? join(homedir(), ".saavy", "cloud");
mkdirSync(home, { recursive: true, mode: 0o700 });

const runner = process.argv.includes("--no-runner") ? undefined : startRunner({ url, token });

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
