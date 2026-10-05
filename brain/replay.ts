// pi's coding tools, made safe to replay. pi never reruns an interrupted "unsafe" tool: after an eviction mid-call the
// model is told it "may have partially run", although the desktop usually finished it. Here each call gets an env
// whose desktop calls are keyed by the tool task (taskId:n; call ids come from the provider and repeat, such as
// "functions.bash:0"), and the runner answers a key it has seen with the first result and output, so a rerun after
// recovery collects what happened instead of doing it again.
import { defineExtension, type Extension, type ToolExecutionApi, type ToolRegistration, wrapTool } from "@earendil-works/pi-durable";
import { RemoteEnv } from "./env.ts";

/** `api` with its env bound to this tool task. */
function keyed(api: ToolExecutionApi): ToolExecutionApi {
	return { ...api, env: api.env instanceof RemoteEnv ? api.env.forCall(`${api.conversationId}/${api.taskId}`) : api.env };
}

export function desktopReplay(tools: readonly ToolRegistration[]): Extension {
	return defineExtension({
		name: "saavy-desktop-replay",
		wraps: tools.map((tool) =>
			wrapTool(tool, (inner) => ({
				...inner,
				replay: "safe",
				execute: (args, api, context) => inner.execute(args, keyed(api), context),
			})),
		),
	});
}
