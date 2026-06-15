# ork — usage examples

Four runnable examples, from the in-memory core up to a deployed HTTP service.
Examples **01 and 02 need no API key** (no LLM, no network); **03 and 04 need an
LLM key** because they drive a real model.

## Setup

From the repo root (installs the workspace, including these examples):

```bash
pnpm install
```

## Run

```bash
pnpm -F @ork.ai/example shell    # 01 — kernel + shell, fully in-memory (no key)
pnpm -F @ork.ai/example tools    # 02 — the 6 Claude-Code tools, called directly (no key)
pnpm -F @ork.ai/example agent    # 03 — a full agent session (needs LLM key)
pnpm -F @ork.ai/example server   # 04 — ork as an HTTP/SSE service (needs LLM key)
pnpm -F @ork.ai/example workspaces # 05 — per-user persistent workspace (no key)
```

(Or directly: `tsx example/01-shell.ts`, etc.)

For 03/04, set one of:

```bash
export AI_GATEWAY_API_KEY=...        # routes "anthropic/claude-..." via the Vercel AI Gateway
# or
export ANTHROPIC_API_KEY=sk-ant-...  # direct Anthropic
```

## What each one shows

| File | Layer | Shows |
|---|---|---|
| `01-shell.ts` | `@ork.ai/kernel` + `@ork.ai/shell` | Seed a virtual FS, run real bash — pipes, `jq`, globs, redirections, `for` loops, heredocs — read artifacts back from the VFS. Zero disk, zero network. |
| `02-tools.ts` | `@ork.ai/tools` | Call `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash` exactly as an agent would, and see the model-facing output (line-numbered reads, self-correctable errors). |
| `03-agent.ts` | `@ork.ai/harness` | `createSession({ model, files })`, `send(prompt)`, stream typed events as the agent works, read the files it produced, snapshot the session. |
| `04-server.ts` | `@ork.ai/server` | Boot the multi-tenant HTTP API (Bearer auth, SSE streaming, snapshot/restore) and the `curl` commands to drive it. |
| `05-workspaces.ts` | Workspace (`@ork.ai/kernel`) + `@ork.ai/harness` | FS persistant par user partagé entre conversations : open/commit, CAS, threads séparés, survie au redémarrage. No key. |

Start with `01` and `02` — they prove the whole substrate (a sandboxed in-memory
bash + tools) works on your machine right now, with nothing to configure.
