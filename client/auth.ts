// `saavy auth login|logout|status`: the device flow against the brain's better-auth (as `tgg login` does for
// textures.gg). The session token lands in ~/.config/saavy/cloud.json (0600), which the front end and the runner read.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_URL = "https://agent.saavylab.dev";
const CLIENT_ID = "saavy-cli";

export interface Credentials {
	readonly url: string;
	readonly token?: string;
	/** Who signed in, for status. */
	readonly name?: string;
}

export const credentialsPath = (): string => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "saavy", "cloud.json");

export function readCredentials(): Credentials {
	const path = credentialsPath();
	const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>) : {};
	return { url: process.env.SAAVY_URL ?? saved.url ?? DEFAULT_URL, ...(process.env.SAAVY_TOKEN ?? saved.token ? { token: process.env.SAAVY_TOKEN ?? saved.token } : {}), ...(saved.name ? { name: saved.name } : {}) };
}

function writeCredentials(credentials: Credentials): void {
	const path = credentialsPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

const post = async (url: string, body: object, token?: string) => {
	const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url: string): void {
	try {
		spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
	} catch {}
}

async function login(base: string, browser: boolean): Promise<void> {
	const start = await post(`${base}/api/auth/device/code`, { client_id: CLIENT_ID });
	const code = start.body as { device_code?: string; user_code?: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
	if (code.device_code === undefined || code.user_code === undefined) throw new Error(`could not start the sign-in (${start.status})`);
	const userCode = code.user_code.replace(/^(.{4})(.+)$/, "$1-$2");
	const link = code.verification_uri_complete ?? `${base}/device?user_code=${code.user_code}`;
	console.log(`Your code: ${userCode}\nApprove it at ${link}`);
	if (browser) openBrowser(link);
	let interval = Math.max(1, code.interval ?? 5) * 1000;
	const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
	while (Date.now() < deadline) {
		await sleep(interval);
		const poll = await post(`${base}/api/auth/device/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: CLIENT_ID });
		const token = poll.body.access_token;
		if (typeof token === "string") {
			const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
			const name = me.ok ? String(((await me.json()) as { name?: string }).name ?? "") : "";
			writeCredentials({ url: base, token, ...(name ? { name } : {}) });
			console.log(`Signed in${name ? ` as ${name}` : ""}. Saved to ${credentialsPath()}.`);
			return;
		}
		switch (poll.body.error) {
			case "authorization_pending":
				break;
			case "slow_down":
				interval += 5000;
				break;
			case "access_denied":
				throw new Error("the sign-in was denied");
			case "expired_token":
				throw new Error("the code expired; run saavy auth login again");
			default:
				throw new Error(`the sign-in failed (${poll.status} ${String(poll.body.error ?? "")})`);
		}
	}
	throw new Error("the code expired; run saavy auth login again");
}

/** One call to the brain, as this signed-in device (through a short-lived client socket). */
async function brainCall<T>(credentials: Credentials, method: string, ...args: unknown[]): Promise<T> {
	if (credentials.token === undefined) throw new Error("not signed in; run saavy auth login");
	const { RemoteSaavy } = await import("./remote.ts");
	const brain = await RemoteSaavy.connect(credentials.url, credentials.token, join(homedir(), ".saavy", "cloud"));
	try {
		return await brain.call<T>(method, ...args);
	} finally {
		brain.close();
	}
}

/** Read a secret from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		process.stdout.write(prompt);
		const stdin = process.stdin;
		let value = "";
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n" || char === "\u0004") {
					stdin.setRawMode?.(false);
					stdin.pause();
					stdin.off("data", onData);
					process.stdout.write("\n");
					return resolve(value.trim());
				}
				if (char === "\u0003") process.exit(130);
				value = char === "\u007f" ? value.slice(0, -1) : value + char;
			}
		};
		stdin.on("data", onData);
	});
}

/** `saavy auth provider login|logout|list [provider]`: the model provider credentials the brain holds. */
async function providerCommand(args: readonly string[], saved: Credentials): Promise<void> {
	const [verb = "list", provider] = args;
	if (verb === "list") {
		const list = await brainCall<{ providerId: string; type: string }[]>(saved, "credentials");
		console.log(list.length === 0 ? "No provider credentials in the brain yet." : list.map((entry) => `${entry.providerId} (${entry.type})`).join("\n"));
		return;
	}
	if (provider === undefined) throw new Error(`usage: saavy auth provider ${verb} <provider>`);
	if (verb === "logout") {
		await brainCall(saved, "deleteCredential", provider);
		console.log(`Removed ${provider} from the brain.`);
		return;
	}
	if (verb !== "login") throw new Error("usage: saavy auth provider login|logout|list [provider]");
	// What pi's /login stored on this machine, else a key typed now.
	const piAuth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
	const local = existsSync(piAuth) ? (JSON.parse(readFileSync(piAuth, "utf8")) as Record<string, { type: string }>)[provider] : undefined;
	let credential: object;
	if (local !== undefined) {
		console.log(`Using the ${local.type === "oauth" ? "sign-in" : "key"} for ${provider} from ${piAuth}.`);
		credential = local;
	} else {
		const key = await askSecret(`API key for ${provider}: `);
		if (key === "") throw new Error("no key given");
		credential = { type: "api_key", key };
	}
	const models = await brainCall<number>(saved, "setCredential", provider, credential);
	console.log(`The brain can use ${provider} now (${models} models).`);
}

/** Run `saavy auth <verb>`; the process exit code. */
export async function authCommand(args: readonly string[]): Promise<number> {
	const [verb = "status"] = args;
	const urlFlag = args.indexOf("--url");
	const saved = readCredentials();
	const base = (urlFlag >= 0 ? args[urlFlag + 1] : undefined) ?? saved.url;
	try {
		if (verb === "provider") await providerCommand(args.slice(1), saved);
		else if (verb === "login") await login(base.replace(/\/$/, ""), !args.includes("--no-browser"));
		else if (verb === "logout") {
			if (saved.token !== undefined) await post(`${saved.url}/api/auth/sign-out`, {}, saved.token).catch(() => undefined);
			writeCredentials({ url: saved.url });
			console.log("Signed out on this device.");
		} else if (verb === "status") {
			if (saved.token === undefined) {
				console.log(`Not signed in to ${saved.url}. Run: saavy auth login`);
				return 1;
			}
			const me = await fetch(`${saved.url}/api/me`, { headers: { authorization: `Bearer ${saved.token}` } });
			if (!me.ok) {
				console.log(`Your sign-in to ${saved.url} has expired or was removed. Run: saavy auth login`);
				return 1;
			}
			console.log(`Signed in to ${saved.url} as ${((await me.json()) as { name: string }).name}.`);
		} else {
			console.log("Usage: saavy auth login [--url URL] [--no-browser] | logout | status | provider login|logout|list [provider]");
			return 2;
		}
		return 0;
	} catch (error) {
		console.error(`saavy auth: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
