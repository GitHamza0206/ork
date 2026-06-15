# ork

ork is a sandboxed agent runtime: it runs LLM coding agents against a fully in-process virtual filesystem and shell, with no host access. A model talks to the system through a small set of Claude-Code-style tools (Bash/Read/Write/Edit/Glob/Grep) that execute against an in-memory kernel + POSIX-ish shell; sessions stream their work over HTTP/SSE, are isolated per tenant, and can be snapshotted and restored content-addressably. Because everything (FS, shell, snapshots) is in-process and deterministic, the whole stack is driveable end to end with a scripted mock model and zero host side effects.

## Packages

| Package | Role |
| --- | --- |
| `@ork.ai/kernel` | Virtual filesystem (VFS), syscalls, permissions/limits, content-addressed snapshot store. |
| `@ork.ai/shell` | POSIX-ish shell (lexer → parser → interpreter) with builtins, expansions, control flow, running on the kernel VFS. |
| `@ork.ai/tools` | The agent tools — Bash, Read, Write, Edit, Glob, Grep — wired to the kernel/shell. |
| `@ork.ai/harness` | Agent session loop: AI SDK tool loop, system prompt, compaction, and the public `SessionEvent` stream. |
| `@ork.ai/server` | Hono HTTP API + SSE, `SessionManager` (tenant isolation, turn lock, snapshot ownership). |
| `@ork.ai/store-s3` | Cloud storage adapters (`S3SnapshotStore`, `S3PointerStore`) over the S3-compatible HTTP API. |

## Storage

The kernel ships in-memory and on-disk stores for snapshots and workspace pointers; both are single-process. For a real SaaS deployment, `@ork.ai/store-s3` provides `S3SnapshotStore` and `S3PointerStore` over the plain S3-compatible HTTP API (works with AWS S3, Cloudflare R2, and MinIO) using `aws4fetch` for SigV4 signing — no heavy SDK. Snapshots are content-addressed blobs/trees; the pointer store implements the optimistic-concurrency CAS contract via conditional writes (`If-None-Match: *` to create, `If-Match: <etag>` to advance), so multiple instances can commit the same workspace without clobbering each other. **Multi-instance pointer safety requires a backend that supports conditional PUT** (R2 and recent AWS S3 do); a backend that answers `501 NotImplemented` is rejected with a clear error rather than silently corrupting pointers.

## Snapshot GC

Snapshots accumulate over time — losing CAS commits, superseded workspace states, deleted sessions — so `gcSnapshots(store, { roots })` reclaims them by **mark-and-sweep from live roots**. Reachability is by *pointer*: the host passes the snapshot ids still referenced (read each known workspace pointer, plus any session-held snapshots) as `roots`; the GC marks every blob referenced by a kept tree, then sweeps any tree or blob that isn't reachable. Orphans' `meta.workspace.parent` chains are explicitly **not** treated as roots (an optional `keepLineageDepth` keeps N ancestors per root for history). The store must implement the listing extension (`ListableSnapshotStore` — Memory, Disk, and S3 all do). Safety rails: GC refuses to run with empty roots on a non-empty store unless `force: true`, and `dryRun: true` reports counts without deleting. **Run GC in a maintenance window** (or while holding the hosts' user locks) — a commit racing the sweep can write a tree after listing, whose shared blobs could then be swept.

## Run the tests

```sh
pnpm test        # runs vitest across all packages (517 tests)
pnpm typecheck   # tsc --noEmit across all packages
```

## Run the end-to-end verification

A standalone script boots the **real** Node HTTP server on a real TCP port and drives it over real HTTP + SSE using a scripted mock model (no LLM key needed). It exercises the full wire path: `fetch → Hono → SessionManager → harness loop → AI SDK tool loop → @ork.ai/tools → @ork.ai/shell → @ork.ai/kernel → VFS → snapshot/restore`.

```sh
node_modules/.bin/tsx scripts/e2e.ts
# or: pnpm dlx tsx scripts/e2e.ts
```

It prints a PASS/FAIL checklist and exits non-zero if any assertion fails. It verifies: session create with seed files, a multi-tool agent turn streamed as SSE (Bash + Write + Bash), FS listing/reads, tenant isolation (403/401), the per-session turn lock (409 `turn_in_flight`), snapshot/restore (incl. cross-tenant denial), and delete.

## Start the server for real

`serve.ts` exposes `startServer(app, port)` over `@hono/node-server`. To run against a real model via the Vercel AI Gateway, use the default identity model resolver (model id strings are routed as `provider/model`) and set the gateway key:

```sh
export AI_GATEWAY_API_KEY=...   # AI SDK gateway credential
```

```ts
import { createApp, SessionManager, startServer } from "@ork.ai/server";

const manager = new SessionManager({
  // default modelResolver is identity: "anthropic/claude-..." is passed to the AI SDK
  // optionally pass an auth fn mapping API key -> tenant id
});
const app = createApp({ manager, auth: (key) => (key === "secret" ? "tenant-a" : null) });
startServer(app, 3000);
```

## HTTP contract

Auth: `Authorization: Bearer <key>` or `x-api-key: <key>`. When an `auth` fn is configured, a missing/invalid key is `401`; accessing another tenant's session/snapshot is `403`. SSE framing is `event: <type>\ndata: <json>\n\n`.

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /v1/sessions` | `{ model, files?, system?, snapshotId? }` | `{ sessionId }` (restores when `snapshotId` given) |
| `POST /v1/sessions/:id/messages` | `{ prompt }` | SSE stream: `text_delta`, `tool_call`, `tool_result`, `step_finish`, `turn_done`, `error`. `409 turn_in_flight` if a turn is already running. |
| `GET /v1/sessions/:id/fs` | — | `{ files: string[] }` |
| `GET /v1/sessions/:id/fs/<path>` | — | raw file bytes (`404` if missing) |
| `POST /v1/sessions/:id/snapshot` | — | `{ snapshotId }` |
| `DELETE /v1/sessions/:id` | — | `{ ok: true, snapshotId? }` (best-effort final snapshot) |
