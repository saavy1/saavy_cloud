// Provider credentials (API keys, OAuth tokens), held by the brain: pi-ai's CredentialStore over its SQLite, in the shape
// of pi's auth.json. Set from a signed-in device (`saavy auth provider login`), never from a model. Writes for one
// provider run one at a time, so an OAuth refresh and a login cannot overwrite each other.
import type { createModels } from "@earendil-works/pi-ai/models";

// pi-ai does not export its auth types; they follow from createModels' options.
type Options = NonNullable<Parameters<typeof createModels>[0]>;
type CredentialStore = NonNullable<Options["credentials"]>;
type AuthContext = NonNullable<Options["authContext"]>;
export type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];

export class SqlCredentialStore implements CredentialStore {
	readonly #sql: SqlStorage;
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		this.#sql.exec("CREATE TABLE IF NOT EXISTS saavy_credentials (provider TEXT PRIMARY KEY, credential TEXT NOT NULL)");
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const rows = this.#sql.exec("SELECT credential FROM saavy_credentials WHERE provider = ?", providerId).toArray();
		return rows.length === 0 ? undefined : (JSON.parse(String(rows[0]!.credential)) as Credential);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return this.#sql
			.exec("SELECT provider, credential FROM saavy_credentials ORDER BY provider")
			.toArray()
			.map((row) => ({ providerId: String(row.provider), type: (JSON.parse(String(row.credential)) as Credential).type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.#serial(providerId, async () => {
			const next = await fn(await this.read(providerId));
			if (next !== undefined) {
				this.#sql.exec(
					"INSERT INTO saavy_credentials (provider, credential) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET credential = excluded.credential",
					providerId,
					JSON.stringify(next),
				);
			}
			return next ?? (await this.read(providerId));
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#serial(providerId, async () => {
			this.#sql.exec("DELETE FROM saavy_credentials WHERE provider = ?", providerId);
		});
	}

	#serial<T>(providerId: string, work: () => Promise<T>): Promise<T> {
		const run = (this.#queues.get(providerId) ?? Promise.resolve()).then(work, work);
		this.#queues.set(
			providerId,
			run.catch(() => {}),
		);
		return run;
	}
}

/** No ambient credentials on Cloudflare: no environment variables or files to fall back on; the store is the source. */
export const NO_AMBIENT_AUTH: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};
