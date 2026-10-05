// The desktop runner on its own, for when no front end is open (the saavy-runner user service, a second computer).
// The brain's address and token: SAAVY_URL and SAAVY_TOKEN, else ~/.config/saavy/cloud.json ({ "url", "token" }).
//
//   node runner/runner.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startRunner } from "./link.ts";

const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "saavy", "cloud.json");
const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { url?: string; token?: string }) : {};
const url = process.env.SAAVY_URL ?? saved.url;
const token = process.env.SAAVY_TOKEN ?? saved.token;
if (url === undefined || token === undefined) {
	console.error(`runner: set SAAVY_URL and SAAVY_TOKEN, or write { "url", "token" } to ${file}`);
	process.exit(2);
}
// Front ends on this machine see this and leave the tools to it.
mkdirSync(join(homedir(), ".saavy"), { recursive: true, mode: 0o700 });
writeFileSync(join(homedir(), ".saavy", "runner.pid"), `${process.pid}\n`);
startRunner({ url: url.replace(/\/ws\/runner$/, ""), token, log: (line) => console.log(line) });
