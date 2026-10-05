# saavy

An endless-chat coding agent with a memory that doesn't forget. One conversation, forever: every message is kept
verbatim, and the model sees the whole history every turn, through a summary tree folded to fit a fixed budget.

The brain runs on Cloudflare. The tools run on your machine.

```
  Tern / any terminal ──┐                        ┌── desktop runner
  (front ends)          │   ┌──────────────────┐ │   (files, shell, your tools)
                        ├──▶│ Brain (Durable   │◀┤
  agent.saavylab.dev    │   │ Object): memory, │ │
  sign-in (GitHub,      │   │ pi-durable loop, │ │
  device codes)         │   │ turn queue       │ │
                        │   └────────┬─────────┘
                                     ▼
                          Workers AI · OpenRouter (AI Gateway)
```

## How it works

- **Memory (OptChat).** The log keeps every message; a binary tree summarizes it (each node ≤ 512 bytes, built in
  order by a cheap model); the *view* is the tree folded under 128 KB, oldest stretches coarsest. Each turn is a
  fresh call with the view in front, so prompts stay byte-stable and cached. The agent can `zoom` any line back to
  the exact messages, and `search` the log verbatim. Everything lives in the Durable Object's SQLite and is read on
  demand, so a history of millions of messages costs the brain a few rows.
- **The loop** is [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) on Cloudflare's `PiHarness`: crash-safe tool calls,
  steering, subagents, and a durable turn queue that survives the brain being evicted at any step.
- **Tools on the desktop.** A runner on your machine dials out over a WebSocket and serves pi's `ExecutionEnv`, so
  pi's own read/write/edit/bash act on your files. Calls are keyed per tool task and their results kept, so a call
  interrupted by an eviction is collected, not repeated.
- **Front ends.** Tern draws it natively (Tern Surface Protocol); any other terminal gets pi-tui. Generative UI (tables,
  checklists, charts) is one spec that every client renders as well as it can.
- **Codemode** runs model-written scripts in Cloudflare Dynamic Workers, with the desktop as a connector.

## Layout

| | |
| --- | --- |
| `core/` | memory (log, tree, view, compactor), prompts, the wire protocols, the UI spec |
| `brain/` | the Worker and Durable Object: SQL store, turn queue, runner and client links, subagents |
| `auth/` | better-auth on D1: GitHub (allowlisted) and device codes |
| `client/` | the front ends (Tern, pi-tui) over a remote client of the brain |
| `runner/` | the desktop runner (in the front end, or standalone as a service) |

## Running it

Tools come from the Nix flake (`direnv allow`); config is code (`cloudflare.config.ts`, deployed with the `cf` CLI).

```sh
npm install
npm test && npm run check
npx cf deploy --secrets-file .prod.vars    # BETTER_AUTH_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
npm run db:migrate                         # auth tables in D1

bin/saavy auth login                       # approve the device in the browser
bin/saavy                                  # chat; runs this machine's runner while open
node runner/runner.ts                      # or keep a runner up on its own
```

It is built for one person. To run your own, change the domain, the D1 id and `ALLOWED_GITHUB_IDS` in
`cloudflare.config.ts`, and register a GitHub OAuth app with the callback `https://<domain>/api/auth/callback/github`.

## Status

A working daily driver, under active development. Next: importing past sessions from other agents into the memory.
