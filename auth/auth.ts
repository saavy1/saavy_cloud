// Who may use the brain: better-auth on D1, the same shape as textures.gg. GitHub is the only way in, and only for
// allowlisted account ids; the CLI and the runner sign in with device codes (`saavy auth login`) and send the session
// token as `Authorization: Bearer`. Every route but sign-in itself requires a session.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export const CLI_CLIENT_ID = "saavy-cli";

export interface AuthEnv {
	readonly DB: D1Database;
	readonly PUBLIC_URL: string;
	readonly ALLOWED_GITHUB_IDS: string;
	readonly BETTER_AUTH_SECRET: string;
	readonly GITHUB_CLIENT_ID: string;
	readonly GITHUB_CLIENT_SECRET: string;
}

const allowedIds = (env: AuthEnv): Set<string> =>
	new Set(
		env.ALLOWED_GITHUB_IDS.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);

const refused = () => new APIError("FORBIDDEN", { message: "This GitHub account may not sign in to saavy." });

function createAuth(env: AuthEnv) {
	const db = drizzle(env.DB, { schema });
	const allowed = allowedIds(env);
	const auth = betterAuth({
		database: drizzleAdapter(db, {
			provider: "sqlite",
			schema: { ...schema, user: schema.users, account: schema.accounts, session: schema.sessions, verification: schema.verifications, deviceCode: schema.deviceCodes },
		}),
		basePath: "/api/auth",
		baseURL: env.PUBLIC_URL,
		trustedOrigins: [env.PUBLIC_URL],
		secret: env.BETTER_AUTH_SECRET,
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
				// Refused before any user row exists.
				mapProfileToUser: (profile) => {
					if (!allowed.has(String(profile.id))) throw refused();
					return {};
				},
			},
		},
		databaseHooks: {
			// And again where the account is written, whatever path got there.
			account: {
				create: {
					before: async (account) => {
						if (account.providerId !== "github" || !allowed.has(account.accountId)) throw refused();
						return { data: account };
					},
				},
			},
		},
		plugins: [
			deviceAuthorization({
				expiresIn: "15m",
				interval: "5s",
				verificationUri: `${env.PUBLIC_URL}/device`,
				validateClient: (clientId) => clientId === CLI_CLIENT_ID,
			}),
			bearer(),
		],
		// A device stays signed in while it is used: 90 days, renewed daily on use.
		session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
		rateLimit: { enabled: true, window: 60, max: 30 },
	});
	return { auth, db, allowed };
}

let cached: ReturnType<typeof createAuth> | undefined;

/** One instance per isolate: the env is the same for every request it serves. */
export function getAuth(env: AuthEnv): ReturnType<typeof createAuth> {
	cached ??= createAuth(env);
	return cached;
}

export interface SignedIn {
	readonly userId: string;
	readonly name: string;
	readonly sessionId: string;
}

/**
 * The session behind `headers` (cookie or bearer token), if its user still holds an allowlisted GitHub account:
 * shrinking the allowlist locks a removed account out at once, sessions and all.
 */
export async function signedIn(env: AuthEnv, headers: Headers): Promise<SignedIn | undefined> {
	const { auth, db, allowed } = getAuth(env);
	const session = await auth.api.getSession({ headers });
	if (session === null) return undefined;
	const github = await db
		.select({ accountId: schema.accounts.accountId })
		.from(schema.accounts)
		.where(and(eq(schema.accounts.userId, session.user.id), eq(schema.accounts.providerId, "github")))
		.get();
	if (github === undefined || !allowed.has(github.accountId)) return undefined;
	return { userId: session.user.id, name: session.user.name, sessionId: session.session.id };
}
