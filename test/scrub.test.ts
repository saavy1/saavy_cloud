import assert from "node:assert/strict";
import { test } from "node:test";
import { scrub } from "../import/scrub.ts";

test("known key formats and secret assignments are redacted; counts and labels are not", () => {
	const fake = "sk-or-v1-" + "a1b2c3d4".repeat(6);
	const { text, hits } = scrub(
		[
			`export OPENROUTER_API_KEY=${fake}`,
			"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI9K7MDENG2bPxRfiCYEXAMPLEKEY",
			"postgres://admin:hunter2pass@db.local:5432/app",
			'"max_tokens": 128000, "tokenizer_revision": "a1b2c3d4e5f6a7b8c9"',
			"password = correct-horse",
		].join("\n"),
	);
	assert.doesNotMatch(text, /a1b2c3d4a1b2c3d4|wJalrXUtnFEMI9K7|hunter2pass/);
	assert.match(text, /\[redacted:openrouter\]/);
	assert.match(text, /"max_tokens": 128000/);
	assert.match(text, /tokenizer_revision": "a1b2c3d4e5f6a7b8c9"/);
	// A plain word (no digits) is not taken for a credential.
	assert.match(text, /password = correct-horse/);
	assert.equal(hits.openrouter, 1);
	assert.equal(hits["url-credentials"], 1);
});
