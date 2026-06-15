import { randomUUID } from "node:crypto";
import {
  createSession,
  restoreSession,
  type Session,
  type SessionConfig,
} from "@ork.ai/harness";
import {
  MemorySnapshotStore,
  type SnapshotStore,
  type PermissionsConfig,
  type Limits,
} from "@ork.ai/kernel";
import type { LanguageModel } from "ai";

/**
 * Maps a model id string (as carried over HTTP) to a concrete model the harness
 * accepts. The default resolver is the identity function: the string is passed
 * straight to the AI SDK (gateway routing of "provider/model"). Tests inject a
 * resolver that returns a scripted mock model instance instead.
 */
export type ModelResolver = (modelId: string) => LanguageModel;

const identityResolver: ModelResolver = (modelId) => modelId;

export interface SessionManagerOptions {
  /** Snapshot store backing snapshot/restore. Defaults to an in-memory store. */
  store?: SnapshotStore;
  /** Resolves a model id string to a LanguageModel. Defaults to identity. */
  modelResolver?: ModelResolver;
  /**
   * Idle TTL for {@link SessionManager.sweep}: a session is eligible for
   * eviction once `now - lastUsed > evictAfterMs` AND it is not busy. Defaults
   * to 30 minutes. Eviction is never automatic — call sweep() yourself or opt
   * in via {@link SessionManager.startSweeper}.
   */
  evictAfterMs?: number;
  /**
   * SECURITY DEFAULT (false): restore is only permitted for a snapshotId whose
   * owning tenant this manager has recorded. The content-addressed store is
   * keyed by hash only — an unguessable hash is NOT an authorization boundary —
   * and the owner map lives in memory, so it is empty after a restart. With the
   * default, an unowned snapshotId (never issued by this process, or issued
   * before a restart) is rejected with 403 rather than silently restored.
   *
   * Set to true ONLY when restoring snapshots whose provenance is established
   * out-of-band (e.g. a durable owner store, or a single-tenant deployment). In
   * that mode an unowned snapshotId is allowed through to the store, where a
   * truly-missing hash surfaces as a 404.
   */
  allowUnownedRestore?: boolean;
}

export interface CreateArgs {
  tenant: string;
  model: string;
  files?: Record<string, string | Uint8Array>;
  system?: string;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
}

export interface RestoreArgs {
  tenant: string;
  snapshotId: string;
  model: string;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
}

interface Entry {
  session: Session;
  tenant: string;
  lastUsed: number;
  snapshotId?: string;
  /** Per-session in-flight turn lock; see tryAcquireTurn/releaseTurn. */
  busy: boolean;
}

/** Raised by the manager when a lookup or authorization check fails; carries an HTTP-ish status. */
export class SessionError extends Error {
  constructor(
    readonly status: 404 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Entry>();
  /** snapshotId -> owning tenant. In-memory; empty after a restart. */
  readonly #snapshotOwners = new Map<string, string>();
  private readonly store: SnapshotStore;
  private readonly resolveModel: ModelResolver;
  private readonly allowUnownedRestore: boolean;
  private readonly evictAfterMs: number;

  constructor(opts: SessionManagerOptions = {}) {
    this.store = opts.store ?? new MemorySnapshotStore();
    this.resolveModel = opts.modelResolver ?? identityResolver;
    this.allowUnownedRestore = opts.allowUnownedRestore ?? false;
    this.evictAfterMs = opts.evictAfterMs ?? 30 * 60 * 1000;
  }

  /** Create a fresh session and return its id. */
  create(args: CreateArgs): string {
    const cfg: SessionConfig = {
      model: this.resolveModel(args.model),
      files: args.files,
      system: args.system,
      mounts: args.mounts,
      network: args.network,
      limits: args.limits,
    };
    const session = createSession(cfg);
    return this.store_(session, args.tenant);
  }

  /**
   * Restore a session from a snapshot and return the new session id.
   *
   * Enforces tenant-scoped restore: the content-addressed store is keyed by
   * hash only, so ownership is tracked separately in #snapshotOwners. If the
   * snapshotId has a recorded owner that is not the caller's tenant, throw 403.
   * If it has NO recorded owner, default-deny with 403 unless the manager was
   * constructed with allowUnownedRestore:true (see SessionManagerOptions).
   */
  async restore(args: RestoreArgs): Promise<string> {
    const owner = this.#snapshotOwners.get(args.snapshotId);
    if (owner !== undefined) {
      if (owner !== args.tenant) {
        throw new SessionError(403, "forbidden", "snapshot belongs to another tenant");
      }
    } else if (!this.allowUnownedRestore) {
      throw new SessionError(403, "forbidden", "unknown or unauthorized snapshot");
    }

    const session = await restoreSession({
      store: this.store,
      snapshotId: args.snapshotId,
      model: this.resolveModel(args.model),
      mounts: args.mounts,
      network: args.network,
      limits: args.limits,
    });
    return this.store_(session, args.tenant, args.snapshotId);
  }

  /** Look up a session, enforcing tenant ownership. Throws SessionError. */
  get(sessionId: string, tenant: string): Entry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new SessionError(404, "session_not_found", `no such session: ${sessionId}`);
    }
    if (entry.tenant !== tenant) {
      throw new SessionError(403, "forbidden", "session belongs to another tenant");
    }
    entry.lastUsed = nowMs();
    return entry;
  }

  /** Snapshot a session, record its owner, and return the new snapshot id. */
  async snapshot(sessionId: string, tenant: string): Promise<string> {
    const entry = this.get(sessionId, tenant);
    const { snapshotId } = await entry.session.snapshot(this.store);
    entry.snapshotId = snapshotId;
    this.#snapshotOwners.set(snapshotId, entry.tenant);
    return snapshotId;
  }

  /**
   * Acquire the per-session turn lock so concurrent turns to the same session
   * cannot interleave against shared mutable kernel FS + messages. Enforces
   * tenant ownership (throws SessionError like get()). Returns false if a turn
   * is already in flight; the caller must NOT start a turn in that case.
   */
  tryAcquireTurn(sessionId: string, tenant: string): boolean {
    const entry = this.get(sessionId, tenant);
    if (entry.busy) return false;
    entry.busy = true;
    return true;
  }

  /** Release the per-session turn lock. No-op if the session is gone. */
  releaseTurn(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.busy = false;
  }

  /**
   * Remove a session, taking a best-effort final snapshot first. Returns the
   * final snapshot id when it succeeded.
   */
  async remove(sessionId: string, tenant: string): Promise<{ snapshotId?: string }> {
    const entry = this.get(sessionId, tenant);
    let snapshotId: string | undefined;
    try {
      const res = await entry.session.snapshot(this.store);
      snapshotId = res.snapshotId;
      this.#snapshotOwners.set(snapshotId, entry.tenant);
    } catch {
      // Best-effort: a snapshot failure must not block eviction.
    }
    this.sessions.delete(sessionId);
    return { snapshotId };
  }

  /**
   * Evict every session idle longer than `evictAfterMs` and not currently busy
   * (a turn in flight is never evicted — it holds shared mutable state). Each
   * evicted session is snapshotted best-effort first, its owner recorded in
   * #snapshotOwners so the tenant can later restore it, and then removed.
   *
   * Returns the evicted session ids plus a sessionId -> snapshotId map so the
   * host can persist restore pointers. A session whose final snapshot failed
   * is still evicted, but absent from `snapshots`.
   */
  async sweep(): Promise<{ evicted: string[]; snapshots: Record<string, string> }> {
    const now = nowMs();
    const evicted: string[] = [];
    const snapshots: Record<string, string> = {};
    for (const [id, entry] of this.sessions) {
      if (entry.busy) continue;
      if (now - entry.lastUsed <= this.evictAfterMs) continue;
      try {
        const { snapshotId } = await entry.session.snapshot(this.store);
        entry.snapshotId = snapshotId;
        this.#snapshotOwners.set(snapshotId, entry.tenant);
        snapshots[id] = snapshotId;
      } catch {
        // Best-effort: a snapshot failure must not block eviction.
      }
      this.sessions.delete(id);
      evicted.push(id);
    }
    return { evicted, snapshots };
  }

  /**
   * Run {@link SessionManager.sweep} on an interval. Returns a handle whose
   * stop() clears the timer. The timer is unref'd so it never keeps the Node
   * process alive on its own. Hosts opt in explicitly — nothing is automatic.
   */
  startSweeper(intervalMs: number): { stop: () => void } {
    const timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    // Don't hold the event loop open just for the sweeper.
    (timer as { unref?: () => void }).unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /** TEST SEAM: backdate a session's lastUsed so sweep() treats it as idle. */
  _setLastUsedForTest(sessionId: string, lastUsed: number): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastUsed = lastUsed;
  }

  private store_(session: Session, tenant: string, snapshotId?: string): string {
    const id = randomUUID();
    this.sessions.set(id, { session, tenant, lastUsed: nowMs(), snapshotId, busy: false });
    return id;
  }
}

// Date.now() is only banned inside workflow scripts; here it merely stamps
// lastUsed for future eviction. crypto.randomUUID() is used for ids.
function nowMs(): number {
  return Date.now();
}
