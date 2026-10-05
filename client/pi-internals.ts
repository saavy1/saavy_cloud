// Two pieces of pi's interactive mode that @earendil-works/pi-coding-agent uses but does not export as values: the
// theme singleton its components draw with, and the keybindings manager CustomEditor needs. The package's exports map
// blocks deep imports, so the modules are loaded by file URL next to the package entry. That resolves to the very
// modules the package itself imports, so the singleton is shared. Pinned with the package version (1.0.2); recheck on
// upgrade.

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const load = async <T>(path: string): Promise<T> => (await import(new URL(path, entry).href)) as T;

const themeModule = await load<{ theme: Theme }>("./modes/interactive/theme/theme.js");
const keybindingsModule = await load<{ KeybindingsManager: { create(agentDir?: string): KeybindingsManager } }>(
	"./core/keybindings.js",
);

export const theme: Theme = themeModule.theme;
export const createKeybindings = (agentDir?: string): KeybindingsManager =>
	keybindingsModule.KeybindingsManager.create(agentDir);
