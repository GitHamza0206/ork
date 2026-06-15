import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isKernelError } from "@ork.ai/kernel";
import { SessionManager, SessionError } from "./session-manager.js";

/**
 * Resolves an API key (Bearer token or x-api-key header) to a tenant id, or
 * null to reject the request with 401. When no auth function is configured the
 * server runs open: the key (if any) is the tenant, else "default".
 */
export type AuthFn = (apiKey: string) => string | null;

export interface CreateAppOptions {
  manager: SessionManager;
  auth?: AuthFn;
}

interface CreateBody {
  model?: unknown;
  files?: unknown;
  system?: unknown;
  mounts?: unknown;
  network?: unknown;
  limits?: unknown;
  snapshotId?: unknown;
}

interface MessagesBody {
  prompt?: unknown;
}

function jsonError(code: string, message: string, status: ContentfulStatusCode): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

export function createApp(opts: CreateAppOptions): Hono {
  const { manager, auth } = opts;
  const app = new Hono();

  /** Extract the tenant from the request, or throw 401 when auth is required. */
  function tenantOf(c: { req: { header: (n: string) => string | undefined } }): string {
    const authz = c.req.header("authorization");
    const bearer = authz?.toLowerCase().startsWith("bearer ")
      ? authz.slice(7).trim()
      : undefined;
    const key = bearer ?? c.req.header("x-api-key");

    if (auth) {
      if (!key) throw jsonError("unauthorized", "missing API key", 401);
      const tenant = auth(key);
      if (!tenant) throw jsonError("unauthorized", "invalid API key", 401);
      return tenant;
    }
    // Open mode: key is the tenant, or "default".
    return key && key.length > 0 ? key : "default";
  }

  async function parseJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw jsonError("bad_request", "invalid JSON body", 400);
    }
  }

  // POST /v1/sessions — create (or restore from snapshotId).
  app.post("/v1/sessions", async (c) => {
    const tenant = tenantOf(c);
    const body = await parseJson<CreateBody>(c);

    if (typeof body.model !== "string" || body.model.length === 0) {
      throw jsonError("bad_request", "`model` (string) is required", 400);
    }
    const model = body.model;
    const mounts = body.mounts as never;
    const network = body.network as never;
    const limits = body.limits as never;

    if (typeof body.snapshotId === "string" && body.snapshotId.length > 0) {
      let sessionId: string;
      try {
        sessionId = await manager.restore({
          tenant,
          snapshotId: body.snapshotId,
          model,
          mounts,
          network,
          limits,
        });
      } catch (err) {
        // Tenant/ownership rejections (SessionError 403) propagate to onError.
        // A missing snapshot (KernelError ENOENT from the store) is a client
        // error, not a 500 — and its raw message must not leak.
        if (err instanceof SessionError) throw err;
        if (isKernelError(err)) {
          throw jsonError("snapshot_not_found", "snapshot not found", 404);
        }
        throw err;
      }
      return c.json({ sessionId });
    }

    if (body.files !== undefined && !isStringRecord(body.files)) {
      throw jsonError("bad_request", "`files` must be an object of path -> string", 400);
    }
    const sessionId = manager.create({
      tenant,
      model,
      files: body.files as Record<string, string> | undefined,
      system: typeof body.system === "string" ? body.system : undefined,
      mounts,
      network,
      limits,
    });
    return c.json({ sessionId });
  });

  // POST /v1/sessions/:id/messages — stream the turn as SSE.
  app.post("/v1/sessions/:id/messages", async (c) => {
    const tenant = tenantOf(c);
    const id = c.req.param("id");
    const entry = lookup(manager, id, tenant);
    const body = await parseJson<MessagesBody>(c);
    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      throw jsonError("bad_request", "`prompt` (string) is required", 400);
    }
    const prompt = body.prompt;

    // Per-session turn lock: concurrent turns would interleave against the
    // shared kernel FS and conversation history. Reject the second turn before
    // opening the stream rather than corrupting state.
    if (!manager.tryAcquireTurn(id, tenant)) {
      throw jsonError("turn_in_flight", "a turn is already running for this session", 409);
    }

    // If the client disconnects mid-SSE, this signal fires; we forward it to
    // the harness so the model call + tool loop stop (no wasted spend). The
    // turn lock is still released in finally below.
    const signal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of entry.session.send(prompt, { signal })) {
          await stream.writeSSE({ data: JSON.stringify(event), event: event.type });
        }
      } catch (err) {
        // session.send() surfaces errors as events and shouldn't throw, but be
        // defensive: emit a terminal error event rather than crashing the stream.
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", message: errText(err) }),
          event: "error",
        });
      } finally {
        manager.releaseTurn(id);
      }
    });
  });

  // GET /v1/sessions/:id/fs (list) — JSON { files }.
  app.get("/v1/sessions/:id/fs", async (c) => {
    const tenant = tenantOf(c);
    const id = c.req.param("id");
    const entry = lookup(manager, id, tenant);
    const files = await entry.session.listFiles();
    return c.json({ files });
  });

  // GET /v1/sessions/:id/fs/* — read a single file.
  app.get("/v1/sessions/:id/fs/*", async (c) => {
    const tenant = tenantOf(c);
    const id = c.req.param("id");
    const entry = lookup(manager, id, tenant);
    // Everything after ".../fs/" is the file path.
    const wildcard = c.req.path.split("/fs/")[1] ?? "";
    const path = "/" + decodeURIComponent(wildcard).replace(/^\/+/, "");

    let bytes: Uint8Array;
    try {
      bytes = await entry.session.readFile(path);
    } catch (err) {
      if (isKernelError(err)) {
        throw jsonError("not_found", `no such file: ${path}`, 404);
      }
      throw err;
    }
    const contentType = looksBinary(bytes) ? "application/octet-stream" : "text/plain; charset=utf-8";
    c.header("content-type", contentType);
    return c.body(toArrayBuffer(bytes));
  });

  // POST /v1/sessions/:id/snapshot — explicit snapshot.
  app.post("/v1/sessions/:id/snapshot", async (c) => {
    const tenant = tenantOf(c);
    const id = c.req.param("id");
    const snapshotId = await manager.snapshot(id, tenant);
    return c.json({ snapshotId });
  });

  // DELETE /v1/sessions/:id — best-effort final snapshot then evict.
  app.delete("/v1/sessions/:id", async (c) => {
    const tenant = tenantOf(c);
    const id = c.req.param("id");
    const { snapshotId } = await manager.remove(id, tenant);
    return c.json(snapshotId ? { ok: true, snapshotId } : { ok: true });
  });

  // Map SessionError + HTTPException to the JSON error shape.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (err instanceof SessionError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    return c.json(
      { error: { code: "internal", message: errText(err) } },
      500,
    );
  });

  return app;
}

function lookup(manager: SessionManager, id: string, tenant: string) {
  try {
    return manager.get(id, tenant);
  } catch (err) {
    if (err instanceof SessionError) {
      throw jsonError(err.code, err.message, err.status);
    }
    throw err;
  }
}

function isStringRecord(v: unknown): v is Record<string, string | Uint8Array> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(
    (x) => typeof x === "string" || x instanceof Uint8Array,
  );
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
