/**
 * Example 4 — Run ork as an HTTP service (multi-tenant, SSE streaming).
 *
 * This boots the real server: agents embedded behind an HTTP API. Each tenant
 * creates sessions, sends messages (streamed back as SSE), reads the resulting
 * files, and snapshots/restores. This is the shape you'd deploy in a SaaS.
 *
 * REQUIRES AN LLM KEY (AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY) because real
 * messages drive a model. The default modelResolver passes the model id string
 * straight to the AI SDK (gateway routing).
 *
 * Run:  pnpm -F @ork.ai/example server      (or: tsx example/04-server.ts)
 * Then, in another terminal, the curl commands printed below.
 */
import { createApp, SessionManager, SessionError, startServer } from "@ork.ai/server";
import { MemorySnapshotStore } from "@ork.ai/kernel";
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

const PORT = 3000;

// MODEL ALLOW-LIST (example-level policy). The default resolver is the identity
// function — it forwards any id straight to the AI Gateway, so a tenant could
// request any/expensive model. A production host pins an allow-list and rejects
// the rest. A SessionError(403, ...) thrown here propagates through
// manager.create()/restore() to the app's onError, which maps it to a 403.
const ALLOWED = new Set(["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4-5"]);

// When ANTHROPIC_API_KEY is set we can also serve a direct-Anthropic alias
// (like example 03): the allowed id "claude-sonnet-4-6" maps to an
// @ai-sdk/anthropic model instance. Otherwise ids route through the Gateway.
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

function allowlistResolver(id: string): LanguageModel {
  if (HAS_ANTHROPIC && id === "claude-sonnet-4-6") {
    return anthropic("claude-sonnet-4-6");
  }
  if (!ALLOWED.has(id)) {
    throw new SessionError(403, "model_not_allowed", `model not allowed: ${id}`);
  }
  return id; // gateway routing of "provider/model"
}

function main() {
  // The SessionManager owns sessions + the snapshot store. modelResolver maps
  // the model id from the HTTP body to a LanguageModel. Swap in DiskSnapshotStore
  // / an R2 adapter for durable, cross-instance sessions. evictAfterMs sets the
  // idle TTL used by sweep()/startSweeper() (default 30m).
  const manager = new SessionManager({
    store: new MemorySnapshotStore(),
    modelResolver: allowlistResolver,
    evictAfterMs: 30 * 60 * 1000,
  });

  // OPT-IN idle eviction: reclaim sessions idle > evictAfterMs and not busy.
  // sweep() snapshots each best-effort first and returns sessionId->snapshotId
  // so you can persist restore pointers. The timer is unref'd. Nothing here is
  // automatic in the server itself — the host wires it up:
  const sweeper = manager.startSweeper(60_000); // sweep every minute

  // A trivial tenant auth: API key -> tenant id. Replace with your own.
  const tenants: Record<string, string> = {
    "key-alice": "alice",
    "key-bob": "bob",
  };
  const app = createApp({
    manager,
    auth: (apiKey) => tenants[apiKey] ?? null, // unknown key -> 401
  });

  const server = startServer(app, PORT);
  const base = `http://localhost:${PORT}`;

  console.log(`=== ork server listening on ${base} ===\n`);
  console.log("Try it (needs AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY set in this process):\n");
  console.log(`# 1. create a session (seeded with a file)`);
  console.log(`curl -s ${base}/v1/sessions -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' \\`);
  console.log(`  -d '{"model":"anthropic/claude-sonnet-4.5","files":{"/notes.txt":"todo: ship ork"}}'`);
  console.log(`# -> {"sessionId":"..."}\n`);
  console.log(`# 2. send a message, stream the agent's work as SSE`);
  console.log(`curl -N ${base}/v1/sessions/<ID>/messages -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' \\`);
  console.log(`  -d '{"prompt":"append a line to /notes.txt and list the file"}'\n`);
  console.log(`# 3. read a file the agent produced`);
  console.log(`curl -s ${base}/v1/sessions/<ID>/fs/notes.txt -H 'Authorization: Bearer key-alice'\n`);
  console.log(`# 4. snapshot, then restore into a fresh session`);
  console.log(`curl -s -XPOST ${base}/v1/sessions/<ID>/snapshot -H 'Authorization: Bearer key-alice'`);
  console.log(`curl -s ${base}/v1/sessions -H 'Authorization: Bearer key-alice' \\`);
  console.log(`  -H 'content-type: application/json' -d '{"model":"anthropic/claude-sonnet-4.5","snapshotId":"<SNAP>"}'\n`);
  console.log("Tenant isolation: key-bob gets 403 on alice's sessions; no key -> 401.");
  console.log(
    `Model policy: only ${[...ALLOWED].join(", ")}${HAS_ANTHROPIC ? ' (+ "claude-sonnet-4-6" direct Anthropic)' : ""} are allowed; anything else -> 403 model_not_allowed.`,
  );
  console.log("Idle sessions are swept every 60s (snapshotted first, then evicted).");
  console.log("Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    sweeper.stop();
    server.close();
    console.log("\nserver stopped.");
    process.exit(0);
  });
}

main();
