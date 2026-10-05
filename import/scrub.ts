// Secrets out of imported history before it leaves this machine: past sessions printed keys, tokens and .env files,
// and the log keeps every message forever. Known formats are matched by shape; generic `name = value` assignments of
// secret-sounding names are redacted when the value looks like a credential. Each hit becomes [redacted:<kind>].

const PATTERNS: readonly [kind: string, pattern: RegExp][] = [
	["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
	["openrouter", /\bsk-or-(?:v1-)?[A-Za-z0-9]{32,}\b/g],
	["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
	["openai", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
	["github", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
	["gitlab", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
	["slack", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
	["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
	["google", /\bAIza[A-Za-z0-9_-]{35}\b/g],
	["stripe", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
	["cloudflare", /\b(?:cfat|cfut)_[A-Za-z0-9_-]{30,}\b/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	["url-credentials", /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{6,}(?=@)/gi],
	["bearer", /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{24,}=*/g],
];

/** `KEY=value`, `"apiKey": "value"`, `token: value` for secret-sounding names, when the value looks like a credential. */
const ASSIGNMENT =
	/((?:^|[\s"'{,(])([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?)([^\s"',}{)]{16,})/gi;

/** Names that sound secret but hold counts or labels (max_tokens, tokenizer_revision, …). */
const NOT_SECRET = /tokens|tokenizer|token_?(?:count|type|id|usage)|secret_?(?:name|ref)/i;

/** Credential-looking: long, mixed classes, not an ordinary word, path, or placeholder. */
function credentialLike(value: string): boolean {
	if (/^(?:\$\{?|<|\[|process\.env|env\.|true|false|null|undefined|https?:\/\/)/i.test(value)) return false;
	if (/^[a-z_]+$/i.test(value) || /^\/|\.(?:ts|js|json|md|rs|nix)$/.test(value)) return false;
	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
	return classes >= 2 && /[0-9]/.test(value);
}

export interface Scrubbed {
	readonly text: string;
	/** Redactions by kind. */
	readonly hits: Readonly<Record<string, number>>;
}

export function scrub(text: string): Scrubbed {
	const hits: Record<string, number> = {};
	const count = (kind: string) => {
		hits[kind] = (hits[kind] ?? 0) + 1;
		return `[redacted:${kind}]`;
	};
	let out = text;
	for (const [kind, pattern] of PATTERNS) out = out.replace(pattern, () => count(kind));
	out = out.replace(ASSIGNMENT, (whole, prefix: string, name: string, value: string) =>
		value.startsWith("[redacted:") || NOT_SECRET.test(name) || !credentialLike(value) ? whole : `${prefix}${count("assignment")}`,
	);
	return { text: out, hits };
}
