import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import { MemorySnapshotStore } from "@ork.ai/kernel";
import { createApp } from "../src/app.js";
import { SessionManager, SessionError, type ModelResolver } from "../src/session-manager.js";
import { scriptedModel, errorPartModel, type ScriptStep } from "./mock-model.js";

// ---- helpers ---------------------------------------------------------------

/** A model resolver returning a fixed scripted model regardless of id. */
function resolverFor(model: LanguageModel): ModelResolver {
  return () => model;
}

/** A scripted model that, given a turn, writes out.txt then answers. */
function writeAndAnswer(): ScriptStep[] {
  return [
    {
      kind: "tools",
      calls: [{ toolName: "Write", input: { file_path: "/out.txt", content: "hello world" } }],
    },
    { kind: "text", text: "done" },
  ];
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

/** Parse an SSE response body into the list of JSON `data:` payloads. */
async function parseSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as SseEvent);
    } catch {
      // ignore non-JSON keepalives
    }
  }
  return events;
}

function app(opts: { resolver?: ModelResolver; auth?: (k: string) => string | null } = {}) {
  const manager = new SessionManager({ modelResolver: opts.resolver });
  return createApp({ manager, auth: opts.auth });
}

async function createSession(
  a: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; sessionId?: string }> {
  const res = await a.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const status = res.status;
  if (status !== 200) return { status };
  const json = (await res.json()) as { sessionId: string };
  return { status, sessionId: json.sessionId };
}

// ---- tests -----------------------------------------------------------------

describe("POST /v1/sessions", () => {
  it("returns a sessionId", async () => {
    const a = app();
    const { status, sessionId } = await createSession(a, { model: "mock/x" });
    expect(status).toBe(200);
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toBeTruthy();
  });

  it("seeds the FS with provided files", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/seed.txt": "abc" },
    });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/seed.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc");
  });

  it("rejects a body without model (400)", async () => {
    const a = app();
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: {} }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("bad_request");
  });

  it("rejects invalid JSON (400)", async () => {
    const a = app();
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sessions/:id/messages (SSE)", () => {
  it("streams tool_call + tool_result + turn_done and writes the file", async () => {
    const a = app({ resolver: resolverFor(scriptedModel(writeAndAnswer())) });
    const { sessionId } = await createSession(a, { model: "mock/x" });

    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "write the file" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSse(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("turn_done");

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall?.tool).toBe("Write");

    // File now exists.
    const fileRes = await a.request(`/v1/sessions/${sessionId}/fs/out.txt`);
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("hello world");
  });

  it("emits text_delta events", async () => {
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "hi there" }])) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "say hi" }),
    });
    const events = await parseSse(res);
    expect(events.some((e) => e.type === "text_delta" && e.text === "hi there")).toBe(true);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });

  it("surfaces a mid-stream error as an {type:error} event (no crash)", async () => {
    const a = app({ resolver: resolverFor(errorPartModel("kaboom")) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "fail please" }),
    });
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("rejects a body without prompt (400)", async () => {
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const a = app();
    const res = await a.request("/v1/sessions/nope/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/sessions/:id/fs", () => {
  it("lists written files", async () => {
    const a = app({ resolver: resolverFor(scriptedModel(writeAndAnswer())) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const msg = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "write" }),
    });
    // Drain the SSE stream so the tool actually runs before we list.
    await parseSse(msg);
    const res = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { files: string[] };
    expect(json.files).toContain("/out.txt");
  });

  it("returns file content for an existing path", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/dir/a.txt": "content-a" },
    });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/dir/a.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("content-a");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 404 for a missing file", async () => {
    const a = app();
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/fs/missing.txt`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("not_found");
  });
});

describe("snapshot + restore", () => {
  it("POST /snapshot returns a snapshotId, restore sees the file", async () => {
    // Single manager => single shared in-memory store across create + restore.
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });

    // Create a session with a seeded file.
    const c1 = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", files: { "/keep.txt": "persisted" } }),
    });
    const { sessionId } = (await c1.json()) as { sessionId: string };

    // Snapshot it.
    const snapRes = await a.request(`/v1/sessions/${sessionId}/snapshot`, { method: "POST" });
    expect(snapRes.status).toBe(200);
    const { snapshotId } = (await snapRes.json()) as { snapshotId: string };
    expect(snapshotId).toBeTruthy();

    // Restore into a brand-new session.
    const c2 = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", snapshotId }),
    });
    expect(c2.status).toBe(200);
    const { sessionId: restoredId } = (await c2.json()) as { sessionId: string };
    expect(restoredId).not.toBe(sessionId);

    const fileRes = await a.request(`/v1/sessions/${restoredId}/fs/keep.txt`);
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("persisted");
  });
});

describe("cross-tenant + unowned snapshot restore (Fix 1)", () => {
  const auth = (key: string): string | null => {
    if (key === "key-alice") return "alice";
    if (key === "key-bob") return "bob";
    return null;
  };

  it("tenant B cannot restore tenant A's snapshot -> 403; A can -> 200 and sees the file", async () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager, auth });

    // Alice creates a session with a seeded file and snapshots it.
    const c1 = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ model: "mock/x", files: { "/secret.txt": "alice-only" } }),
    });
    const { sessionId } = (await c1.json()) as { sessionId: string };
    const snapRes = await a.request(`/v1/sessions/${sessionId}/snapshot`, {
      method: "POST",
      headers: { authorization: "Bearer key-alice" },
    });
    const { snapshotId } = (await snapRes.json()) as { snapshotId: string };
    expect(snapshotId).toBeTruthy();

    // Bob tries to restore Alice's snapshot -> 403 forbidden.
    const bob = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-bob" },
      body: JSON.stringify({ model: "mock/x", snapshotId }),
    });
    expect(bob.status).toBe(403);
    const bobJson = (await bob.json()) as { error: { code: string } };
    expect(bobJson.error.code).toBe("forbidden");

    // Alice restores her own snapshot -> 200 and sees the file.
    const alice = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ model: "mock/x", snapshotId }),
    });
    expect(alice.status).toBe(200);
    const { sessionId: restoredId } = (await alice.json()) as { sessionId: string };
    const fileRes = await a.request(`/v1/sessions/${restoredId}/fs/secret.txt`, {
      headers: { authorization: "Bearer key-alice" },
    });
    expect(fileRes.status).toBe(200);
    expect(await fileRes.text()).toBe("alice-only");
  });

  it("default-deny: restoring an unowned (never-issued) snapshotId -> 403", async () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", snapshotId: "deadbeef-not-a-real-snapshot" }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("forbidden");
  });

  it("allowUnownedRestore:true -> unknown hash falls through to 404 snapshot_not_found (not 500)", async () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
      allowUnownedRestore: true,
    });
    const a = createApp({ manager });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x", snapshotId: "deadbeef-not-a-real-snapshot" }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("snapshot_not_found");
  });
});

describe("per-session turn lock (Fix 2)", () => {
  it("tryAcquireTurn is exclusive; releaseTurn frees it", () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const id = manager.create({ tenant: "default", model: "mock/x" });
    expect(manager.tryAcquireTurn(id, "default")).toBe(true);
    // Already busy.
    expect(manager.tryAcquireTurn(id, "default")).toBe(false);
    manager.releaseTurn(id);
    // Freed again.
    expect(manager.tryAcquireTurn(id, "default")).toBe(true);
  });

  it("tryAcquireTurn enforces tenant ownership (throws for wrong tenant)", () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const id = manager.create({ tenant: "alice", model: "mock/x" });
    expect(() => manager.tryAcquireTurn(id, "bob")).toThrow(SessionError);
  });

  it("POST /messages while a turn is in flight -> 409 turn_in_flight", async () => {
    const manager = new SessionManager({
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });
    const id = manager.create({ tenant: "default", model: "mock/x" });
    // Simulate an in-flight turn by acquiring the lock out-of-band.
    expect(manager.tryAcquireTurn(id, "default")).toBe(true);

    const res = await a.request(`/v1/sessions/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("turn_in_flight");
  });

  it("a normal turn releases the lock so a subsequent turn succeeds", async () => {
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "ok" }])) });
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const r1 = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "first" }),
    });
    await parseSse(r1);
    const r2 = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "second" }),
    });
    expect(r2.status).toBe(200);
  });
});

describe("DELETE /v1/sessions/:id", () => {
  it("removes the session (subsequent GET -> 404)", async () => {
    const a = app();
    const { sessionId } = await createSession(a, {
      model: "mock/x",
      files: { "/x.txt": "y" },
    });
    const del = await a.request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const json = (await del.json()) as { ok: boolean; snapshotId?: string };
    expect(json.ok).toBe(true);

    const after = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(after.status).toBe(404);
  });
});

describe("abort-on-disconnect (Fix: turn abort)", () => {
  it("aborting the request mid-turn releases the lock so a later turn succeeds", async () => {
    // A slow model keeps the turn in flight; we abort the request mid-stream.
    const a = app({ resolver: resolverFor(scriptedModel([{ kind: "text", text: "late" }], 100)) });
    const { sessionId } = await createSession(a, { model: "mock/x" });

    const ac = new AbortController();
    const p = a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "go" }),
      signal: ac.signal,
    });
    // Abort shortly after the request opens (turn is in flight).
    setTimeout(() => ac.abort(), 10);
    try {
      const res = await p;
      // If the response resolved, drain it (it may carry an aborted error event).
      await res.text().catch(() => undefined);
    } catch {
      // app.request may reject with the abort — that's fine; the point is the lock.
    }

    // Give the finally{} a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    // The lock must have been released: a subsequent turn is NOT 409.
    const r2 = await a.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "second" }),
    });
    expect(r2.status).not.toBe(409);
    expect(r2.status).toBe(200);
  });
});

describe("idle session eviction (sweep)", () => {
  function mgr() {
    return new SessionManager({
      store: new MemorySnapshotStore(),
      modelResolver: resolverFor(scriptedModel([{ kind: "text", text: "x" }])),
      evictAfterMs: 1000,
    });
  }

  it("evicts an idle session, records+returns its snapshotId, leaves a fresh one intact", async () => {
    const manager = mgr();
    const idle = manager.create({ tenant: "alice", model: "mock/x", files: { "/a.txt": "keep" } });
    const fresh = manager.create({ tenant: "alice", model: "mock/x" });

    // Force the idle session's lastUsed far into the past via the test seam.
    manager._setLastUsedForTest(idle, Date.now() - 60_000);

    const { evicted } = await manager.sweep();
    expect(evicted).toContain(idle);
    expect(evicted).not.toContain(fresh);

    // The fresh session is still usable.
    expect(() => manager.get(fresh, "alice")).not.toThrow();
    // The evicted session is gone -> get throws 404.
    expect(() => manager.get(idle, "alice")).toThrow(SessionError);
  });

  it("sweep result maps evicted sessionId -> snapshotId, and that snapshot is restorable by the same tenant", async () => {
    const manager = mgr();
    const idle = manager.create({ tenant: "alice", model: "mock/x", files: { "/secret.txt": "alice-only" } });
    manager._setLastUsedForTest(idle, Date.now() - 60_000);

    const result = await manager.sweep();
    const snapId = result.snapshots[idle];
    expect(typeof snapId).toBe("string");
    expect(snapId).toBeTruthy();

    // The same tenant can restore from the recorded snapshot (owner preserved).
    const restoredId = await manager.restore({ tenant: "alice", snapshotId: snapId!, model: "mock/x" });
    expect(restoredId).toBeTruthy();
    const entry = manager.get(restoredId, "alice");
    expect(entry).toBeDefined();
  });

  it("never evicts a busy session (turn in flight)", async () => {
    const manager = mgr();
    const busy = manager.create({ tenant: "alice", model: "mock/x" });
    manager._setLastUsedForTest(busy, Date.now() - 60_000);
    expect(manager.tryAcquireTurn(busy, "alice")).toBe(true); // mark busy

    const { evicted } = await manager.sweep();
    expect(evicted).not.toContain(busy);
    expect(() => manager.get(busy, "alice")).not.toThrow();
  });

  it("startSweeper returns a stoppable handle and sweeps on its interval", async () => {
    const manager = mgr();
    const idle = manager.create({ tenant: "alice", model: "mock/x" });
    manager._setLastUsedForTest(idle, Date.now() - 60_000);

    const handle = manager.startSweeper(5);
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    expect(() => manager.get(idle, "alice")).toThrow(SessionError);
  });
});

describe("model allow-list (example-level policy)", () => {
  const ALLOWED = new Set(["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4-5"]);
  function allowlistResolver(scripted: LanguageModel): ModelResolver {
    return (id: string) => {
      if (!ALLOWED.has(id)) {
        throw new SessionError(403, "model_not_allowed", `model not allowed: ${id}`);
      }
      return scripted;
    };
  }

  it("POST /v1/sessions with a disallowed model -> 403 model_not_allowed", async () => {
    const manager = new SessionManager({
      modelResolver: allowlistResolver(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o" }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("model_not_allowed");
  });

  it("POST /v1/sessions with an allowed model -> 200", async () => {
    const manager = new SessionManager({
      modelResolver: allowlistResolver(scriptedModel([{ kind: "text", text: "x" }])),
    });
    const a = createApp({ manager });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.5" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("auth + tenant isolation", () => {
  const auth = (key: string): string | null => {
    if (key === "key-alice") return "alice";
    if (key === "key-bob") return "bob";
    return null;
  };

  it("missing key -> 401 when auth is configured", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(401);
  });

  it("invalid key -> 401", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bogus" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(401);
  });

  it("a tenant cannot access another tenant's session -> 403", async () => {
    const a = app({ auth });
    const { sessionId } = await createSession(
      a,
      { model: "mock/x", files: { "/secret.txt": "s" } },
      { authorization: "Bearer key-alice" },
    );
    // Alice can read it.
    const ok = await a.request(`/v1/sessions/${sessionId}/fs`, {
      headers: { authorization: "Bearer key-alice" },
    });
    expect(ok.status).toBe(200);
    // Bob cannot.
    const forbidden = await a.request(`/v1/sessions/${sessionId}/fs`, {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("accepts the key via x-api-key header too", async () => {
    const a = app({ auth });
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-alice" },
      body: JSON.stringify({ model: "mock/x" }),
    });
    expect(res.status).toBe(200);
  });

  it("open mode (no auth) treats key as tenant, defaults to 'default'", async () => {
    const a = app();
    // No key -> "default" tenant; create then access without a key.
    const { sessionId } = await createSession(a, { model: "mock/x" });
    const res = await a.request(`/v1/sessions/${sessionId}/fs`);
    expect(res.status).toBe(200);
  });
});
