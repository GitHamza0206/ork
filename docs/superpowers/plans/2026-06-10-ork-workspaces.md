# Workspaces persistants par user — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un filesystem persistant **par user**, partagé entre toutes ses conversations — chaque conversation gardant son propre historique. `Workspace` devient un objet de première classe (open/commit avec CAS), `createSession` compose un workspace + un thread, et un exemple runnable démontre tout le cycle (multi-conversations, multi-users, conflit, survie au redémarrage), zéro DB.

**Architecture:** Le FS d'un user = une chaîne de snapshots content-addressed dans le `SnapshotStore` existant, référencée par un **pointeur versionné** (`PointerStore`, CAS). `Workspace.open(id)` restaure le FS courant (lazy) ; `Workspace.commit()` snapshot FS-only + avance le pointeur par compare-and-swap (conflit → `WorkspaceConflictError`). Les messages d'une conversation n'entrent **jamais** dans le store de blobs : ils restent côté hôte (JSON par convId). `createSession({ workspace, messages })` recompose les deux. Le `session.snapshot()` couplé existant (FS+messages) reste intact — c'est un autre cas d'usage (`@ork.ai/server` en dépend).

**Tech Stack:** TypeScript strict + noUncheckedIndexedAccess, ESM NodeNext, vitest, pnpm workspace. Aucune dépendance nouvelle. Tests harness avec le mock `MockLanguageModelV2` existant ; démo exécutée via tsx avec le mock inline (pattern de `scripts/e2e.ts`).

**Décisions verrouillées (issues de la revue de design) :**
- Pas de booléens sur `snapshot()` : `Workspace.commit()` est FS-only *par nature*. L'API précédemment envisagée (`includeMessages: false`, override sur `restoreSession`) est abandonnée.
- `Workspace` vit dans `@ork.ai/kernel` (pur FS, zéro concept LLM). Le harness ne fait que le composer.
- CAS par version monotone (`version: number`, 0 = inexistant). `DiskPointerStore` est atomique **intra-process** (mutex par id + write-temp-puis-rename) ; le multi-instance exige un store à écriture conditionnelle (R2/S3 If-Match, DB) — documenté, pas implémenté.
- Les ids de workspace doivent matcher `^[A-Za-z0-9_-]{1,128}$` (même règle que le store disque). Un hôte avec des userIds exotiques (emails) les hashe lui-même.
- Quand `workspace` est fourni à `createSession`, la config kernel (`mounts`/`network`/`limits`/`fetchImpl`) de `SessionConfig` est **ignorée** — elle a été fixée à `Workspace.open`. `workspace` + `files` simultanés → erreur EINVAL.
- Lineage : le meta du snapshot de commit contient `{ workspace: { id, parent } }` — prépare un GC mark-and-sweep et l'historique par workspace. Conséquence assumée : deux commits au même contenu FS mais de lignées différentes ont des manifests différents (les blobs dédupliquent quand même).
- Conventions hôte (démontrées dans l'exemple, pas imposées par la lib) : wipe de `/tmp` à chaque tour ; ligne de system prompt « workspace partagé entre tes conversations ».

---

## Pré-requis

- Repo : `/Users/mac/ork`, partir de `main` (517 tests verts + example/).
- Toutes les commandes depuis `/Users/mac/ork`.

---

### Task 1: `PointerStore` — pointeurs versionnés avec CAS (`@ork.ai/kernel`)

**Files:**
- Create: `packages/kernel/src/workspace/pointer-store.ts`
- Create: `packages/kernel/src/workspace/disk-pointer-store.ts`
- Test: `packages/kernel/test/pointer-store.test.ts`

- [ ] **Step 1: Créer la branche**

```bash
git checkout -b feat/workspace
```

- [ ] **Step 2: Écrire le test qui échoue**

`packages/kernel/test/pointer-store.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPointerStore, type PointerStore } from "../src/workspace/pointer-store.js";
import { DiskPointerStore } from "../src/workspace/disk-pointer-store.js";

function suite(name: string, make: () => Promise<{ store: PointerStore; cleanup(): Promise<void> }>) {
  test(`${name}: get on unknown id → null`, async () => {
    const { store, cleanup } = await make();
    try {
      expect(await store.get("u1")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test(`${name}: first set requires expectedVersion 0`, async () => {
    const { store, cleanup } = await make();
    try {
      expect(await store.set("u1", { snapshotId: "a", version: 1 }, 0)).toBe(true);
      expect(await store.get("u1")).toEqual({ snapshotId: "a", version: 1 });
      // re-création avec expectedVersion 0 alors que v1 existe → refus
      expect(await store.set("u1", { snapshotId: "b", version: 1 }, 0)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: CAS advances only from the expected version`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "a", version: 1 }, 0);
      expect(await store.set("u1", { snapshotId: "b", version: 2 }, 1)).toBe(true);
      // un écrivain retardataire qui croit encore être en v1 → refus
      expect(await store.set("u1", { snapshotId: "c", version: 2 }, 1)).toBe(false);
      expect(await store.get("u1")).toEqual({ snapshotId: "b", version: 2 });
    } finally {
      await cleanup();
    }
  });

  test(`${name}: ids are isolated`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "a", version: 1 }, 0);
      expect(await store.get("u2")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test(`${name}: concurrent CAS — exactly one winner`, async () => {
    const { store, cleanup } = await make();
    try {
      await store.set("u1", { snapshotId: "base", version: 1 }, 0);
      const results = await Promise.all([
        store.set("u1", { snapshotId: "x", version: 2 }, 1),
        store.set("u1", { snapshotId: "y", version: 2 }, 1),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
}

suite("memory", async () => ({ store: new MemoryPointerStore(), cleanup: async () => {} }));

suite("disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  return {
    store: new DiskPointerStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

test("disk: unsafe id rejected with EINVAL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  try {
    const store = new DiskPointerStore(dir);
    await expect(store.get("../evil")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.set("a/b", { snapshotId: "x", version: 1 }, 0)).rejects.toMatchObject({
      code: "EINVAL",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disk: pointer survives a new store instance (restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-ptr-"));
  try {
    const a = new DiskPointerStore(dir);
    await a.set("u1", { snapshotId: "s1", version: 1 }, 0);
    const b = new DiskPointerStore(dir); // « redémarrage »
    expect(await b.get("u1")).toEqual({ snapshotId: "s1", version: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL (modules introuvables).

- [ ] **Step 4: Implémenter**

`packages/kernel/src/workspace/pointer-store.ts`:
```ts
/** Référence mutable « état courant d'un workspace » → un snapshot immuable. */
export interface WorkspacePointer {
  snapshotId: string;
  /** Version monotone pour la concurrence optimiste (CAS). Premier commit → 1. */
  version: number;
}

export interface PointerStore {
  get(id: string): Promise<WorkspacePointer | null>;
  /**
   * Compare-and-swap : n'écrit `pointer` que si la version stockée vaut
   * `expectedVersion` (0 = le pointeur ne doit pas encore exister). Retourne
   * false quand la précondition échoue (un autre écrivain a gagné).
   */
  set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean>;
}

export class MemoryPointerStore implements PointerStore {
  #map = new Map<string, WorkspacePointer>();

  async get(id: string): Promise<WorkspacePointer | null> {
    return this.#map.get(id) ?? null;
  }

  async set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean> {
    const current = this.#map.get(id)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.#map.set(id, pointer);
    return true;
  }
}
```

`packages/kernel/src/workspace/disk-pointer-store.ts`:
```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KernelError } from "../errors.js";
import type { PointerStore, WorkspacePointer } from "./pointer-store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new KernelError("EINVAL", `unsafe workspace id: ${id}`);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Pointeurs sur disque : pointers/<id>.json. CAS atomique INTRA-PROCESS
 * uniquement (mutex par id + write-temp-puis-rename). Pour du multi-instance,
 * utiliser un store à écriture conditionnelle (R2/S3 If-Match, DB).
 */
export class DiskPointerStore implements PointerStore {
  #locks = new Map<string, Promise<unknown>>();

  constructor(private rootDir: string) {}

  #path(id: string): string {
    assertSafeId(id);
    return join(this.rootDir, "pointers", `${id}.json`);
  }

  async get(id: string): Promise<WorkspacePointer | null> {
    const path = this.#path(id);
    try {
      return JSON.parse(await readFile(path, "utf8")) as WorkspacePointer;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean> {
    const path = this.#path(id);
    // Sérialise les set() concurrents sur le même id dans CE process.
    const tail = this.#locks.get(id) ?? Promise.resolve();
    const run = tail.then(async () => {
      const current = (await this.get(id))?.version ?? 0;
      if (current !== expectedVersion) return false;
      await mkdir(join(this.rootDir, "pointers"), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(pointer));
      await rename(tmp, path); // write atomique
      return true;
    });
    this.#locks.set(id, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }
}
```

- [ ] **Step 5: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS ; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/workspace packages/kernel/test/pointer-store.test.ts
git commit -m "feat(kernel): versioned workspace pointers with CAS (memory + disk)"
```

---

### Task 2: `Workspace` — open / commit / conflit (`@ork.ai/kernel`)

**Files:**
- Create: `packages/kernel/src/workspace/workspace.ts`
- Test: `packages/kernel/test/workspace.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

`packages/kernel/test/workspace.test.ts`:
```ts
import { expect, test } from "vitest";
import { Workspace, WorkspaceConflictError } from "../src/workspace/workspace.js";
import { MemoryPointerStore } from "../src/workspace/pointer-store.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function stores() {
  return { store: new MemorySnapshotStore(), pointers: new MemoryPointerStore() };
}

test("open on unknown id → empty workspace (or seeded)", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s, seed: { "/workspace/hello.txt": "hi" } });
  expect(dec.decode(await ws.kernel.sys.readFile("/workspace/hello.txt"))).toBe("hi");
});

test("commit → pointer advances; reopen sees committed state", async () => {
  const s = stores();
  const ws1 = await Workspace.open({ id: "u1", ...s });
  await ws1.kernel.sys.mkdir("/workspace", { recursive: true });
  await ws1.kernel.sys.writeFile("/workspace/a.txt", "v1");
  const { snapshotId } = await ws1.commit();
  expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
  expect(await s.pointers.get("u1")).toEqual({ snapshotId, version: 1 });

  const ws2 = await Workspace.open({ id: "u1", ...s });
  expect(dec.decode(await ws2.kernel.sys.readFile("/workspace/a.txt"))).toBe("v1");
});

test("successive commits chain versions and lineage", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  await ws.kernel.sys.writeFile("/a.txt", "1");
  const c1 = await ws.commit();
  await ws.kernel.sys.writeFile("/a.txt", "2");
  const c2 = await ws.commit();
  expect((await s.pointers.get("u1"))!.version).toBe(2);
  // lineage : le manifest du 2e commit référence le 1er comme parent
  const manifest = await s.store.getTree(c2.snapshotId);
  expect(manifest?.meta).toMatchObject({ workspace: { id: "u1", parent: c1.snapshotId } });
});

test("two open workspaces on the same id: second commit → WorkspaceConflictError", async () => {
  const s = stores();
  const seedWs = await Workspace.open({ id: "u1", ...s, seed: { "/base.txt": "b" } });
  await seedWs.commit();

  const a = await Workspace.open({ id: "u1", ...s });
  const b = await Workspace.open({ id: "u1", ...s });
  await a.kernel.sys.writeFile("/from-a.txt", "a");
  await b.kernel.sys.writeFile("/from-b.txt", "b");
  await a.commit(); // gagne
  await expect(b.commit()).rejects.toBeInstanceOf(WorkspaceConflictError);
  // l'état gagnant est celui de a (vfs.exists est synchrone)
  const ws = await Workspace.open({ id: "u1", ...s });
  expect(ws.kernel.vfs.exists("/from-a.txt")).toBe(true);
  expect(ws.kernel.vfs.exists("/from-b.txt")).toBe(false);
});

test("workspaces of different ids are isolated", async () => {
  const s = stores();
  const u = await Workspace.open({ id: "u1", ...s });
  await u.kernel.sys.writeFile("/secret.txt", "u1 only");
  await u.commit();
  const v = await Workspace.open({ id: "u2", ...s });
  expect(v.kernel.vfs.exists("/secret.txt")).toBe(false);
});

test("kernel config (mounts/limits) is applied at open", async () => {
  const s = stores();
  const seedWs = await Workspace.open({ id: "u1", ...s, seed: { "/ro/doc.md": "x" } });
  await seedWs.commit();
  const ws = await Workspace.open({ id: "u1", ...s, mounts: [{ path: "/ro", mode: "ro" }] });
  await expect(ws.kernel.sys.writeFile("/ro/nope.txt", "x")).rejects.toMatchObject({
    code: "EACCES",
  });
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

`packages/kernel/src/workspace/workspace.ts`:
```ts
import { createKernel, restoreKernel, type Kernel, type KernelOptions } from "../kernel.js";
import type { SnapshotStore } from "../snapshot/store.js";
import type { PointerStore } from "./pointer-store.js";

/** Un commit concurrent a avancé le pointeur entre open() et commit(). */
export class WorkspaceConflictError extends Error {
  constructor(readonly workspaceId: string) {
    super(`workspace ${workspaceId}: concurrent commit detected (pointer moved)`);
    this.name = "WorkspaceConflictError";
  }
}

export interface WorkspaceOpenOptions extends Omit<KernelOptions, "files"> {
  /** Identifiant du workspace (ex. userId). Doit matcher [A-Za-z0-9_-]{1,128} pour les stores disque. */
  id: string;
  store: SnapshotStore;
  pointers: PointerStore;
  /** Fichiers seedés à la PREMIÈRE ouverture (workspace inexistant). Ignoré ensuite. */
  seed?: Record<string, string | Uint8Array>;
}

/**
 * Le « repo » d'un user : un FS persistant référencé par un pointeur versionné.
 * open() restaure l'état courant (lazy) ; commit() snapshot FS-only + avance le
 * pointeur par CAS. Les messages de conversation ne passent JAMAIS par ici —
 * ils appartiennent à l'hôte (un thread par conversation).
 */
export class Workspace {
  private constructor(
    readonly id: string,
    readonly kernel: Kernel,
    private readonly store: SnapshotStore,
    private readonly pointers: PointerStore,
    private version: number,
    private parentSnapshotId: string | null,
  ) {}

  static async open(opts: WorkspaceOpenOptions): Promise<Workspace> {
    const { id, store, pointers, seed, ...kernelOpts } = opts;
    const pointer = await pointers.get(id);
    if (pointer) {
      const { kernel } = await restoreKernel({ store, snapshotId: pointer.snapshotId, ...kernelOpts });
      return new Workspace(id, kernel, store, pointers, pointer.version, pointer.snapshotId);
    }
    const kernel = createKernel({ files: seed, ...kernelOpts });
    return new Workspace(id, kernel, store, pointers, 0, null);
  }

  /**
   * Snapshot FS-only + avance le pointeur (CAS). Le meta porte la lignée
   * ({workspace:{id,parent}}) pour l'historique et un futur GC. Conflit →
   * WorkspaceConflictError : l'hôte rejoue le tour sur un workspace ré-ouvert
   * ou renvoie 409.
   */
  async commit(): Promise<{ snapshotId: string }> {
    const { snapshotId } = await this.kernel.snapshot(this.store, {
      meta: { workspace: { id: this.id, parent: this.parentSnapshotId } },
    });
    const next = this.version + 1;
    const ok = await this.pointers.set(this.id, { snapshotId, version: next }, this.version);
    if (!ok) throw new WorkspaceConflictError(this.id);
    this.version = next;
    this.parentSnapshotId = snapshotId;
    return { snapshotId };
  }
}
```

Note : `kernel.snapshot(store, {meta})` n'inclut **aucun message** — c'est l'API kernel, pas celle de la session. Le snapshot de commit est FS + lignée, rien d'autre.

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS ; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/workspace/workspace.ts packages/kernel/test/workspace.test.ts
git commit -m "feat(kernel): Workspace — open/commit with CAS pointer advance"
```

---

### Task 3: Exports publics kernel

**Files:**
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Ajouter les exports** (à la fin du fichier) :

```ts
export {
  MemoryPointerStore,
  type PointerStore,
  type WorkspacePointer,
} from "./workspace/pointer-store.js";
export { DiskPointerStore } from "./workspace/disk-pointer-store.js";
export {
  Workspace,
  WorkspaceConflictError,
  type WorkspaceOpenOptions,
} from "./workspace/workspace.js";
```

- [ ] **Step 2: Vérifier** — `pnpm -F @ork.ai/kernel test && pnpm -F @ork.ai/kernel typecheck` → verts.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/index.ts
git commit -m "feat(kernel): export Workspace + PointerStore API"
```

---

### Task 4: `createSession({ workspace, messages })` (`@ork.ai/harness`)

**Files:**
- Modify: `packages/harness/src/session.ts`
- Modify: `packages/harness/src/index.ts` (si besoin — vérifier que les types réexportés suffisent)
- Test: `packages/harness/test/workspace-session.test.ts`

**Contexte requis :** lire `packages/harness/src/session.ts` d'abord. `buildSession(kernel, cfg & {initialMessages?})` existe déjà (utilisé par `restoreSession`) ; `createSession` construit aujourd'hui son kernel via `createKernel({files,...})` puis appelle `buildSession`. Le mock de test est `packages/harness/test/mock-model.ts`.

- [ ] **Step 1: Écrire le test qui échoue**

`packages/harness/test/workspace-session.test.ts`:
```ts
import { expect, test } from "vitest";
import {
  MemoryPointerStore,
  MemorySnapshotStore,
  Workspace,
} from "@ork.ai/kernel";
import { createSession } from "../src/session.js";
import { scriptedModel } from "./mock-model.js"; // adapter le nom à l'export réel du helper

const dec = new TextDecoder();

function stores() {
  return { store: new MemorySnapshotStore(), pointers: new MemoryPointerStore() };
}

async function drain(events: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

test("two conversations share one user workspace", async () => {
  const s = stores();

  // — conversation A : écrit un fichier via le tool Bash —
  const wsA = await Workspace.open({ id: "u1", ...s, seed: { "/workspace/.keep": "" } });
  const convA = createSession({
    model: scriptedModel([
      { toolCalls: [{ tool: "Bash", input: { command: "echo from-A > /workspace/notes.md" } }] },
      { text: "noted" },
    ]),
    workspace: wsA,
    messages: [],
  });
  await drain(convA.send("note quelque chose"));
  await wsA.commit();

  // — conversation B (HISTORIQUE INDÉPENDANT) : lit le fichier de A —
  const wsB = await Workspace.open({ id: "u1", ...s });
  const convB = createSession({
    model: scriptedModel([
      { toolCalls: [{ tool: "Read", input: { file_path: "/workspace/notes.md" } }] },
      { text: "read it" },
    ]),
    workspace: wsB,
    messages: [],
  });
  const events = await drain(convB.send("lis les notes"));
  const toolResults = events.filter(
    (e): e is { type: string; output: string } => (e as { type: string }).type === "tool_result",
  );
  expect(toolResults.some((r) => r.output.includes("from-A"))).toBe(true);
  // les threads sont indépendants : B ne contient pas le tour de A
  expect(JSON.stringify(convB.messages)).not.toContain("note quelque chose");
});

test("messages seeds the thread; conversation grows on top of it", async () => {
  const prior = [
    { role: "user" as const, content: "tour précédent" },
    { role: "assistant" as const, content: "réponse précédente" },
  ];
  const session = createSession({
    model: scriptedModel([{ text: "suite" }]),
    files: {},
    messages: prior,
  });
  expect(session.messages).toHaveLength(2);
  await drain(session.send("nouveau tour"));
  expect(session.messages.length).toBeGreaterThan(2);
  expect(JSON.stringify(session.messages[0])).toContain("tour précédent");
});

test("workspace + files together → EINVAL", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  // createSession throw synchrone → toThrowError, pas .rejects
  expect(() =>
    createSession({ model: scriptedModel([{ text: "x" }]), workspace: ws, files: { "/a": "x" } }),
  ).toThrowError(/EINVAL/);
});

test("session FS effects land in the workspace kernel (commit persists them)", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  const session = createSession({
    model: scriptedModel([
      { toolCalls: [{ tool: "Write", input: { file_path: "/out.txt", content: "persisted" } }] },
      { text: "done" },
    ]),
    workspace: ws,
  });
  await drain(session.send("écris"));
  await ws.commit();
  const reopened = await Workspace.open({ id: "u1", ...s });
  expect(dec.decode(await reopened.kernel.sys.readFile("/out.txt"))).toBe("persisted");
});
```

**Note d'adaptation :** lire `packages/harness/test/mock-model.ts` et utiliser son API réelle (nom d'export, forme des steps tool-call/text). Si sa forme diffère de `scriptedModel([{toolCalls|text}])`, adapter les appels du test à l'API existante — ne PAS réécrire le mock.

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/harness test` → FAIL (`workspace`/`messages` inconnus de SessionConfig).

- [ ] **Step 3: Implémenter** dans `packages/harness/src/session.ts` :

Ajouter à l'import kernel existant : `Workspace` (type) et `KernelError` :
```ts
import { createKernel, restoreKernel, KernelError, type Kernel, type SnapshotStore, type Workspace } from "@ork.ai/kernel";
```
(fusionner avec la ligne d'import existante — ne pas dupliquer.)

Ajouter à `SessionConfig` :
```ts
  /**
   * Workspace externe (FS partagé, géré par Workspace.open/commit). Mutuellement
   * exclusif avec `files`. La config kernel (mounts/network/limits/fetchImpl)
   * de cette SessionConfig est ignorée : elle a été fixée à Workspace.open.
   */
  workspace?: Workspace;
  /**
   * Historique initial de la conversation (thread géré par l'hôte). La session
   * démarre avec ces messages et les fait croître ; à l'hôte de re-sauvegarder
   * `session.messages` après le tour.
   */
  messages?: ModelMessage[];
```

Remplacer le corps de `createSession` :
```ts
export function createSession(cfg: SessionConfig): Session {
  if (cfg.workspace && cfg.files) {
    throw new KernelError("EINVAL", "createSession: `workspace` and `files` are mutually exclusive");
  }
  const kernel = cfg.workspace
    ? cfg.workspace.kernel
    : createKernel({
        files: cfg.files,
        mounts: cfg.mounts,
        network: cfg.network,
        limits: cfg.limits,
        fetchImpl: cfg.fetchImpl,
      });
  return buildSession(kernel, { ...cfg, initialMessages: cfg.messages });
}
```
(Le `createSession` actuel passe déjà par `buildSession` — conserver tout le reste tel quel. Si la signature actuelle diffère légèrement, adapter en gardant l'intention : workspace → son kernel ; sinon comportement inchangé.)

Vérifier que `restoreSession` n'est PAS modifié (son couplage FS+messages est le contrat de `@ork.ai/server`).

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/harness test` → PASS (27 existants + 4 nouveaux) ; `pnpm test` racine → tout vert (kernel avec ses nouveaux tests, shell 329, tools 61, server 26) ; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/harness/src/session.ts packages/harness/test/workspace-session.test.ts
git commit -m "feat(harness): createSession composes a Workspace + host-owned thread"
```

---

### Task 5: Démo runnable `example/05-workspaces.ts` (zéro DB, zéro clé)

**Files:**
- Create: `example/05-workspaces.ts`
- Create: `example/mock-model.ts`
- Modify: `example/package.json` (script `workspaces`)
- Modify: `example/README.md` (ligne de tableau)

- [ ] **Step 1: Extraire le mock model**

Lire `scripts/e2e.ts` et **copier** son helper de modèle scripté (la classe/fonction qui implémente `LanguageModelV2.doStream` en émettant `stream-start` / `tool-call` (input JSON-stringifié) / `text-*` / `finish` depuis une file de steps — il fonctionne sous tsx, contrairement à `ai/test`). Le placer dans `example/mock-model.ts` avec un export propre, p.ex. :
```ts
export function scriptedModel(steps: Step[]): LanguageModelV2;
export type Step = { text: string } | { toolCalls: Array<{ tool: string; input: unknown }> };
```
Adapter les noms aux structures réelles trouvées dans `scripts/e2e.ts` — copier le code qui marche, ne pas réinventer les stream parts.

- [ ] **Step 2: Écrire la démo**

`example/05-workspaces.ts` — structure complète (adapter les appels au mock à l'API de `example/mock-model.ts`) :

```ts
/**
 * Example 5 — Un filesystem persistant PAR USER, partagé entre conversations.
 *
 * Le pattern serveur complet, sans DB et sans clé LLM (mock model) :
 *   - Workspace.open(userId)  → restaure le FS du user (pointeur + snapshots)
 *   - createSession({ workspace, messages }) → compose FS partagé + thread
 *   - ws.commit()             → nouveau snapshot + avance le pointeur (CAS)
 *   - threads/<convId>.json   → l'historique, simple JSON côté hôte
 * Démontre : partage entre conversations d'un même user, isolation entre
 * users, conflit de commit concurrent, et survie à un « redémarrage ».
 *
 * Run:  pnpm -F @ork.ai/example workspaces
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskPointerStore,
  DiskSnapshotStore,
  Workspace,
  WorkspaceConflictError,
} from "@ork.ai/kernel";
import { createSession } from "@ork.ai/harness";
import type { ModelMessage } from "ai";
import { scriptedModel } from "./mock-model.js";

// ── le « stockage » : un dossier, c'est tout ─────────────────────────────
const DATA_DIR = await mkdtemp(join(tmpdir(), "ork-workspaces-"));

function makeStores() {
  // Recréés à chaque « redémarrage » : seule la donnée sur disque persiste.
  return {
    store: new DiskSnapshotStore(DATA_DIR),
    pointers: new DiskPointerStore(DATA_DIR),
  };
}

// ── threads : un JSON par conversation, géré par l'hôte ──────────────────
const threadsDir = join(DATA_DIR, "conversations");
await mkdir(threadsDir, { recursive: true });
async function loadThread(convId: string): Promise<ModelMessage[]> {
  try {
    return JSON.parse(await readFile(join(threadsDir, `${convId}.json`), "utf8"));
  } catch {
    return [];
  }
}
async function saveThread(convId: string, messages: readonly ModelMessage[]) {
  await writeFile(join(threadsDir, `${convId}.json`), JSON.stringify(messages));
}

// ── lock par user (mono-process) : sérialise restore→turn→commit ─────────
const userLocks = new Map<string, Promise<unknown>>();
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const tail = userLocks.get(userId) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  userLocks.set(userId, run.then(() => undefined, () => undefined));
  return run;
}

const SYSTEM =
  "Tu travailles dans un workspace partagé entre toutes les conversations de cet " +
  "utilisateur. Des fichiers ont pu changer depuis ton dernier tour : relis avant " +
  "de te fier à ta mémoire. /tmp est effacé à chaque tour.";

// ── LE pattern serveur : un tour = lock → open → session → commit → save ──
async function runTurn(opts: {
  userId: string;
  convId: string;
  prompt: string;
  model: ReturnType<typeof scriptedModel>;
}) {
  return withUserLock(opts.userId, async () => {
    const { store, pointers } = makeStores();
    const ws = await Workspace.open({ id: opts.userId, store, pointers });

    // convention hôte : /tmp est par-tour
    await ws.kernel.sys.rm("/tmp", { recursive: true }).catch(() => {});
    await ws.kernel.sys.mkdir("/tmp", { recursive: true });

    const session = createSession({
      model: opts.model,
      workspace: ws,
      messages: await loadThread(opts.convId),
      system: SYSTEM,
    });
    const events: Array<{ type: string }> = [];
    for await (const ev of session.send(opts.prompt)) events.push(ev as { type: string });

    const { snapshotId } = await ws.commit();
    await saveThread(opts.convId, session.messages);
    return { events, snapshotId, session };
  });
}

// ── la démo, avec assertions PASS/FAIL ────────────────────────────────────
const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean) {
  checks.push({ name, ok });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
}

console.log(`=== ork workspaces — data dir: ${DATA_DIR} ===\n`);

// 1. Conversation A du user hamza écrit un fichier dans le workspace.
await runTurn({
  userId: "hamza",
  convId: "conv-A",
  prompt: "note nos décisions dans le workspace",
  model: scriptedModel([
    { toolCalls: [{ tool: "Bash", input: { command: "mkdir -p /workspace && echo 'decision: ship ork' > /workspace/notes.md" } }] },
    { text: "Noté dans /workspace/notes.md." },
  ]),
});

// 2. Conversation B — MÊME user, AUTRE thread — lit le fichier de A.
const b = await runTurn({
  userId: "hamza",
  convId: "conv-B",
  prompt: "qu'est-ce qu'on a décidé ?",
  model: scriptedModel([
    { toolCalls: [{ tool: "Read", input: { file_path: "/workspace/notes.md" } }] },
    { text: "On a décidé: ship ork." },
  ]),
});
const bRead = b.events.find(
  (e) => e.type === "tool_result" && JSON.stringify(e).includes("ship ork"),
);
check("conv B (même user) voit le fichier écrit par conv A", Boolean(bRead));
check(
  "les threads A et B sont indépendants",
  !JSON.stringify(await loadThread("conv-B")).includes("note nos décisions"),
);

// 3. Un AUTRE user ne voit rien.
const v = await runTurn({
  userId: "marc",
  convId: "conv-C",
  prompt: "lis les notes",
  model: scriptedModel([
    { toolCalls: [{ tool: "Read", input: { file_path: "/workspace/notes.md" } }] },
    { text: "rien" },
  ]),
});
const vMiss = v.events.find(
  (e) => e.type === "tool_result" && JSON.stringify(e).includes("does not exist"),
);
check("le user marc ne voit PAS le workspace de hamza", Boolean(vMiss));

// 4. Conflit : deux commits concurrents sur le même user → un seul gagne.
{
  const { store, pointers } = makeStores();
  const w1 = await Workspace.open({ id: "hamza", store, pointers });
  const w2 = await Workspace.open({ id: "hamza", store, pointers });
  await w1.kernel.sys.writeFile("/workspace/w1.txt", "1");
  await w2.kernel.sys.writeFile("/workspace/w2.txt", "2");
  await w1.commit();
  let conflicted = false;
  try {
    await w2.commit();
  } catch (err) {
    conflicted = err instanceof WorkspaceConflictError;
  }
  check("commit concurrent → WorkspaceConflictError (zéro lost update)", conflicted);
}

// 5. « Redémarrage » : nouveaux objets stores sur le même dossier → tout survit.
{
  const { store, pointers } = makeStores(); // ← simule un nouveau process
  const ws = await Workspace.open({ id: "hamza", store, pointers });
  const notes = new TextDecoder().decode(await ws.kernel.sys.readFile("/workspace/notes.md"));
  check("après redémarrage, le FS du user est intact", notes.includes("ship ork"));
  check("après redémarrage, le thread de conv A est intact", (await loadThread("conv-A")).length > 0);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n==== ${checks.length - failed.length}/${checks.length} checks passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
```

- [ ] **Step 3: Câbler les scripts/docs**

`example/package.json` → ajouter `"workspaces": "tsx 05-workspaces.ts"` aux scripts.
`example/README.md` → ajouter la ligne : `| 05-workspaces.ts | Workspace (@ork.ai/kernel) + @ork.ai/harness | non | FS persistant par user partagé entre conversations : open/commit, CAS, threads séparés, survie au redémarrage. |` et la commande `pnpm -F @ork.ai/example workspaces` dans le bloc Run.

- [ ] **Step 4: Exécuter et itérer jusqu'au vert**

```bash
pnpm install   # si nécessaire
pnpm -F @ork.ai/example workspaces
```
Expected : `6/6 checks passed`, exit 0, pas de hang. Si un check échoue à cause d'un détail du mock ou d'un message d'erreur de tool différent, corriger la démo (ou remonter un vrai bug de lib — le signaler).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -F @ork.ai/example typecheck
git add example
git commit -m "docs(example): per-user persistent workspace demo (05)"
```

---

### Task 6: Vérification finale, revue, merge

- [ ] **Step 1: Suite complète**

```bash
pnpm test && pnpm typecheck && node_modules/.bin/tsx scripts/e2e.ts | tail -2 && pnpm -F @ork.ai/example workspaces | tail -2
```
Expected : tous les packages verts (≥ 530 tests au total : 517 + ~13 nouveaux), e2e 32/32, démo 6/6.

- [ ] **Step 2: Revue finale** (subagent reviewer sur `git diff main..feat/workspace`) — points d'attention :
- CAS réellement sans lost-update (probe : deux commits concurrents via DiskPointerStore)
- `restoreSession`/`@ork.ai/server` non cassés (rétro-compat du snapshot couplé)
- `createSession({workspace})` ignore bien la config kernel de SessionConfig (documenté) et EINVAL sur workspace+files
- pas de fuite des messages dans les snapshots de commit (inspecter un manifest)
- mock copié de e2e fonctionne sous tsx

- [ ] **Step 3: Merge**

```bash
git checkout main && git merge feat/workspace --no-edit && pnpm test && git branch -d feat/workspace
```

---

## Couverture besoin → tâches

| Besoin exprimé | Tâche(s) |
|---|---|
| FS persisté **par user** (pas par conversation) | 1, 2 (pointeur par id user + snapshots) |
| Plusieurs conversations du même user sur le même FS | 4 (`createSession({workspace, messages})`), 5 (démo conv A/B) |
| Historique séparé par conversation | 4 (`messages` seedé, `session.messages` re-sauvé par l'hôte), 5 (threads JSON) |
| Persistance « au global », survit au redémarrage | 1 (DiskPointerStore), 5 (check redémarrage) |
| Zéro DB obligatoire | 1+5 (pointeurs et threads = JSON sur disque/bucket) |
| Pas de lost update entre conversations concurrentes | 1+2 (CAS) + 5 (lock par user + démo conflit) |
| Isolation entre users | 2 (tests), 5 (démo user marc) |
| Rétro-compat (`@ork.ai/server`, `session.snapshot()` couplé) | 4 (restoreSession intact) + 6 (revue) |
| Multi-instance / GC des snapshots | **Hors scope, préparé** : interface PointerStore (conditional-put R2/S3), lignée `parent` dans le meta |

## Risques & décisions assumées

- **DiskPointerStore = atomicité intra-process.** Suffisant mono-instance ; le multi-instance passera par un PointerStore R2/S3 (If-Match) ou DB — interface déjà prête. Documenté dans le code.
- **Ids de workspace contraints** à `[A-Za-z0-9_-]{1,128}` : un host avec des emails hashe. Explicite > magique.
- **Config kernel figée à `open`** : si deux conversations ouvrent le même workspace avec des `mounts` différents, chacune a SES règles pour SON tour — c'est voulu (la policy est par-session), mais à connaître.
- **Le mock `ai/test` ne charge pas sous tsx** (leçon de l'E2E) : la démo réutilise le mock inline de `scripts/e2e.ts`, les tests vitest gardent `MockLanguageModelV2`.
