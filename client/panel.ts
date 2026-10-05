// A saavy panel: a separate Tern pane (opened with `tern split`) that draws one agent UI full-pane. It connects back to
// the saavy process over a Unix socket, takes the UI and live ops as JSON lines, and sends clicks back. The UI arrives
// with saavy's wire ids already namespaced, so ops apply as they are.
//
//   saavy-panel --socket <path> --handle <name>

import { connect } from "node:net";
import { createInterface } from "node:readline";
import { matchesKey } from "@earendil-works/pi-tui";
import { handshake, Surface } from "./tsp/surface.ts";

const arg = (name: string): string | undefined => {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? undefined : process.argv[index + 1];
};
const socketPath = arg("socket");
const handle = arg("handle") ?? "ui";
if (socketPath === undefined) {
	console.error("saavy-panel: --socket is required");
	process.exit(2);
}

const shake = await handshake([]);
if (shake.hello === undefined) {
	console.error("saavy-panel: this terminal does not speak the Tern Surface Protocol");
	process.exit(1);
}

const socket = connect(socketPath);
const send = (message: object) => socket.write(`${JSON.stringify(message)}\n`);
let done = false;
let surface: Surface;

const finish = async (): Promise<void> => {
	if (done) return;
	done = true;
	socket.end();
	await surface.close();
	process.exit(0);
};

surface = new Surface(shake.hello, {
	event: (body) => {
		if (body.ev === "action" || body.ev === "activate") send({ type: "event", body });
	},
	key: (sequence) => {
		if (sequence === "q" || matchesKey(sequence, "ctrl+c") || matchesKey(sequence, "escape")) void finish();
	},
	paste: () => {},
});
if (shake.kitty) process.stdout.write("\x1b[>1u");
surface.open({
	main: { id: "main", k: "col", c: [] },
	dock: { id: "dock", k: "col", c: [{ id: "hint", k: "text", p: { spans: [{ t: `${handle} · q closes`, s: "muted" }] } }] },
	layer: { id: "layer", k: "col", c: [] },
});

let root: string | undefined;
const lines = createInterface({ input: socket });
lines.on("error", () => void finish());
lines.on("line", (line) => {
	const message = JSON.parse(line) as { type: string; node?: Record<string, unknown>; ops?: unknown[][]; title?: string };
	if (message.type === "show" && message.node !== undefined) {
		const ops: unknown[][] = root === undefined ? [] : [["del", root]];
		// The UI goes in a card titled for it; the card is what the next show removes.
		root = `${message.node.id as string}.card`;
		const title = message.title ?? handle;
		ops.push(["add", root, "main", null, { id: root, k: "card", p: { head: title, tone: "accent" }, c: [message.node] }]);
		surface.op(...ops);
		process.stdout.write(`\x1b]0;${title}\x07`);
	} else if (message.type === "ops" && message.ops !== undefined) {
		surface.op(...message.ops);
	} else if (message.type === "close") void finish();
});
socket.on("connect", () => send({ type: "hello", handle }));
socket.on("close", () => void finish());
socket.on("error", () => void finish());
