// The desktop runner on its own, for when no front end is open (the saavy-runner user service, a second computer).
// It signs in like the front end: `saavy auth login` once, then the token in ~/.config/saavy/cloud.json.
//
//   node runner/runner.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialsPath, readCredentials } from "../client/auth.ts";
import { startRunner } from "./link.ts";

const { url, token } = readCredentials();
if (token === undefined) {
	console.error(`runner: not signed in (${credentialsPath()}); run: saavy auth login`);
	process.exit(2);
}
// Front ends on this machine see this and leave the tools to it.
mkdirSync(join(homedir(), ".saavy"), { recursive: true, mode: 0o700 });
writeFileSync(join(homedir(), ".saavy", "runner.pid"), `${process.pid}\n`);
startRunner({ url: url.replace(/\/ws\/runner$/, ""), token, log: (line) => console.log(line) });
