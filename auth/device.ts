// The page `saavy auth login` sends you to: sign in with GitHub, check the code your terminal shows, approve or deny.
// Plain HTML and a little script over better-auth's endpoints (same origin, so the session cookie just works).

export const DEVICE_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>saavy · sign in a device</title>
<style>
	:root { --bg: #f6f5f2; --fg: #1d1c1a; --muted: #6b6862; --card: #fff; --line: #e3e0da; --accent: #3b5bdb; --danger: #c92a2a; }
	@media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #ecebe8; --muted: #9a978f; --card: #1d1c1a; --line: #2e2c29; --accent: #7b93ff; --danger: #ff6b6b; } }
	* { box-sizing: border-box; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; padding: 16px; }
	main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
	h1 { font-size: 20px; margin: 0 0 4px; }
	p { color: var(--muted); margin: 0 0 20px; }
	input { width: 100%; font: 600 24px/1 ui-monospace, monospace; letter-spacing: 0.12em; text-align: center; text-transform: uppercase; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); margin-bottom: 16px; }
	button { width: 100%; font: inherit; font-weight: 600; padding: 11px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
	button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
	.row { display: flex; gap: 10px; }
	.who { font-size: 14px; color: var(--muted); margin-top: 18px; text-align: center; }
	.msg { margin-top: 16px; text-align: center; }
	.err { color: var(--danger); }
	[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
	<h1>Sign in a device to saavy</h1>
	<p id="lead">Checking your session…</p>
	<section id="signin" hidden><button class="primary" id="github">Continue with GitHub</button></section>
	<section id="approve" hidden>
		<input id="code" autocomplete="off" spellcheck="false" maxlength="9" placeholder="ABCD-EFGH">
		<div class="row"><button id="deny">Deny</button><button class="primary" id="allow">Approve</button></div>
	</section>
	<div class="msg" id="msg"></div>
	<div class="who" id="who"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const api = (path, init) => fetch("/api/auth" + path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init });
const params = new URLSearchParams(location.search);
const say = (text, error) => { $("msg").textContent = text; $("msg").className = "msg" + (error ? " err" : ""); };
const normal = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.+)$/, "$1-$2");

async function start() {
	if (params.get("error")) say("GitHub sign-in failed: " + params.get("error"), true);
	const session = await (await api("/get-session")).json().catch(() => null);
	if (!session || !session.user) {
		$("lead").textContent = "Sign in with GitHub first. Only the owner's account is allowed.";
		$("signin").hidden = false;
		return;
	}
	$("who").textContent = "Signed in as " + session.user.name;
	$("lead").textContent = "Check that this code matches the one in your terminal.";
	$("approve").hidden = false;
	$("code").value = normal(params.get("user_code") || "");
	$("code").focus();
}

$("github").onclick = async () => {
	const res = await api("/sign-in/social", { method: "POST", body: JSON.stringify({ provider: "github", callbackURL: location.href, errorCallbackURL: location.pathname + "?error=refused" }) });
	const body = await res.json().catch(() => ({}));
	if (body.url) location.href = body.url; else say(body.message || "Could not start the GitHub sign-in.", true);
};

async function decide(approve) {
	const code = normal($("code").value);
	if (code.length !== 9) return say("Enter the 8-character code from your terminal.", true);
	const check = await api("/device?user_code=" + encodeURIComponent(code), { method: "GET" });
	const found = await check.json().catch(() => ({}));
	if (!check.ok || found.status !== "pending") return say("That code is unknown, expired, or already used.", true);
	const res = await api(approve ? "/device/approve" : "/device/deny", { method: "POST", body: JSON.stringify({ userCode: code }) });
	if (!res.ok) return say(((await res.json().catch(() => ({}))).message) || "That did not work.", true);
	$("approve").hidden = true;
	$("lead").textContent = approve ? "Approved. You can go back to your terminal." : "Denied. The device was not signed in.";
	say("");
}
$("allow").onclick = () => decide(true);
$("deny").onclick = () => decide(false);
$("code").onkeydown = (event) => { if (event.key === "Enter") decide(true); };
start();
</script>
</body>
</html>
`;
