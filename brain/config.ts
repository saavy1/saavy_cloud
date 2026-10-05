// Settings the user changes while saavy runs, kept in the brain's SQLite.
import type { ModelThinkingLevel, OpenRouterRouting } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export interface Config {
	/** `<provider>/<id>`: a Workers AI `@cf/…` id, or e.g. `openrouter/deepseek/deepseek-v4.1-flash`. */
	readonly model: string;
	readonly thinking: ModelThinkingLevel;
	readonly compactor: { readonly model: string; readonly thinking: ModelThinkingLevel | "off" };
	/** The agent's working directory on the desktop; the runner's home until set. */
	readonly cwd?: string;
}

export const DEFAULTS: Config = {
	model: "openrouter/deepseek/deepseek-v4.1-flash",
	thinking: "low",
	// Off: thinking makes each summary several times slower, and the next turn waits on them.
	compactor: { model: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "off" },
};

/** OpenRouter providers per model: prices vary a lot between hosts, so pin the ones the user chose. */
export const ROUTING: Record<string, OpenRouterRouting> = {
	"deepseek/deepseek-v4.1-flash": { order: ["deepseek", "baseten"], only: ["deepseek", "baseten"], allow_fallbacks: true },
};

export function modelRef(spec: string): ModelRef {
	const slash = spec.indexOf("/");
	return spec.startsWith("@cf/") || slash < 0 ? { provider: "cloudflare", modelId: spec } : { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

export class ConfigStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec("CREATE TABLE IF NOT EXISTS saavy_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
	}

	get(): Config {
		const rows = this.#sql.exec("SELECT v FROM saavy_meta WHERE k = 'config'").toArray();
		return rows.length === 0 ? DEFAULTS : { ...DEFAULTS, ...(JSON.parse(String(rows[0]!.v)) as Partial<Config>) };
	}

	set(change: Partial<Config>): Config {
		const next = { ...this.get(), ...change };
		this.#sql.exec("INSERT INTO saavy_meta (k, v) VALUES ('config', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(next));
		return next;
	}
}
