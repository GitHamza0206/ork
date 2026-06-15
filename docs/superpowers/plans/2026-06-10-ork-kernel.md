# @ork.ai/kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire `@ork.ai/kernel` — VFS in-memory, syscalls avec middlewares (trace/permissions/quotas), process virtuels async, event bus typé, snapshot content-addressed avec restore lazy.

**Architecture:** Micro-kernel : un `Vfs` (Map path→inode), une frontière syscall où chaque appel traverse une chaîne de middlewares, une `ProcTable` de process virtuels en Web Streams, un `EventBus` typé, et un module snapshot (blobs SHA-256 + manifest) avec stores mémoire/disque. Spec source : `docs/superpowers/specs/2026-06-10-ork-runtime-design.md`.

**Tech Stack:** TypeScript strict (ESM, NodeNext), pnpm workspace, vitest, Web Streams + `crypto.subtle` (portable Node/Workers), `node:fs/promises` uniquement dans le store disque.

**Décisions prises au planning (écarts mineurs vs spec, assumés) :**
- `open`/`read`/`write` fusionnés en `readFile`/`writeFile` (lecture/écriture de fichier entier) → 11 syscalls au lieu de 12. Le streaming intra-session passe par les pipes de procs, pas par des fd. YAGNI.
- Ordre des middlewares : **trace en premier (outermost)** pour que les refus de permission et dépassements de quota soient eux aussi tracés. La spec listait permissions→quotas→trace ; trace-outermost est strictement plus observable.
- `SnapshotStore` gagne `hasBlob(hash)` (en plus de put/get) pour l'upload incrémental sans télécharger le blob.
- Quota `maxFsBytes` vérifié de façon pessimiste sur overwrite (`totalBytes() + bytes` sans déduire l'ancienne taille). Simple, sûr, documenté.

---

## Pré-requis

- Node ≥ 20 (crypto.subtle, Web Streams, fetch globaux), pnpm installé.
- Repo : `/Users/mac/ork` (le repo git dédié, PAS le repo home).
- Toutes les commandes s'exécutent depuis `/Users/mac/ork` sauf mention contraire.

---

### Task 1: Scaffold monorepo + package @ork.ai/kernel

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/kernel/package.json`, `packages/kernel/tsconfig.json`
- Create: `packages/kernel/src/index.ts`, `packages/kernel/test/smoke.test.ts`

- [ ] **Step 1: Créer la branche de travail**

```bash
git checkout -b feat/kernel
```

- [ ] **Step 2: Écrire les fichiers de config**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`package.json` (racine):
```json
{
  "name": "ork",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
```

`packages/kernel/package.json`:
```json
{
  "name": "@ork.ai/kernel",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/kernel/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/kernel/src/index.ts`:
```ts
export const KERNEL_VERSION = "0.0.1";
```

`packages/kernel/test/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { KERNEL_VERSION } from "../src/index.js";

test("package loads", () => {
  expect(KERNEL_VERSION).toBe("0.0.1");
});
```

- [ ] **Step 3: Installer et vérifier**

```bash
pnpm install
pnpm -F @ork.ai/kernel test
pnpm -F @ork.ai/kernel typecheck
```
Expected: 1 test PASS, typecheck sans erreur.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo + @ork.ai/kernel package"
```

---

### Task 2: Erreurs typées (`errors.ts`)

**Files:**
- Create: `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/errors.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { KernelError, isKernelError } from "../src/errors.js";

test("KernelError carries code and formatted message", () => {
  const err = new KernelError("ENOENT", "/missing.txt");
  expect(err.code).toBe("ENOENT");
  expect(err.message).toBe("ENOENT: /missing.txt");
  expect(err.name).toBe("KernelError");
  expect(err).toBeInstanceOf(Error);
});

test("isKernelError narrows correctly", () => {
  expect(isKernelError(new KernelError("EQUOTA", "x"))).toBe(true);
  expect(isKernelError(new Error("x"))).toBe(false);
  expect(isKernelError(null)).toBe(false);
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter**

```ts
export type ErrnoCode =
  | "ENOENT"
  | "EEXIST"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EACCES"
  | "EINVAL"
  | "EQUOTA"
  | "ETIMEOUT"
  | "ENETBLOCKED";

export class KernelError extends Error {
  readonly code: ErrnoCode;

  constructor(code: ErrnoCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "KernelError";
    this.code = code;
  }
}

export function isKernelError(err: unknown): err is KernelError {
  return err instanceof KernelError;
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/errors.ts packages/kernel/test/errors.test.ts
git commit -m "feat(kernel): typed KernelError with errno codes"
```

---

### Task 3: Chemins virtuels (`path.ts`)

**Files:**
- Create: `packages/kernel/src/path.ts`
- Test: `packages/kernel/test/path.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { normalizePath, parentOf, basename } from "../src/path.js";
import { KernelError } from "../src/errors.js";

test("normalizePath canonicalizes", () => {
  expect(normalizePath("/a/b/../c")).toBe("/a/c");
  expect(normalizePath("/a//b/./c/")).toBe("/a/b/c");
  expect(normalizePath("/")).toBe("/");
});

test("relative paths resolve against cwd", () => {
  expect(normalizePath("b.txt", "/work")).toBe("/work/b.txt");
  expect(normalizePath("../x", "/work/sub")).toBe("/work/x");
});

test(".. clamps at root, never escapes", () => {
  expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd");
  expect(normalizePath("../../..", "/a")).toBe("/");
});

test("null byte rejected with EINVAL", () => {
  expect(() => normalizePath("/a\0b")).toThrowError(KernelError);
  try {
    normalizePath("/a\0b");
  } catch (e) {
    expect((e as KernelError).code).toBe("EINVAL");
  }
});

test("parentOf and basename", () => {
  expect(parentOf("/a/b/c")).toBe("/a/b");
  expect(parentOf("/a")).toBe("/");
  expect(basename("/a/b.txt")).toBe("b.txt");
  expect(basename("/")).toBe("/");
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import { KernelError } from "./errors.js";

/** Canonicalise un chemin virtuel. `..` est clampé à la racine (pas d'évasion possible). */
export function normalizePath(path: string, cwd = "/"): string {
  if (path.includes("\0")) throw new KernelError("EINVAL", "null byte in path");
  const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function basename(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/path.ts packages/kernel/test/path.test.ts
git commit -m "feat(kernel): virtual path normalization, root-clamped"
```

---

### Task 4: Event bus typé (`events.ts`)

**Files:**
- Create: `packages/kernel/src/events.ts`
- Test: `packages/kernel/test/events.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test, vi } from "vitest";
import { EventBus, type KernelEvent } from "../src/events.js";

test("emit delivers to all subscribers", () => {
  const bus = new EventBus();
  const a = vi.fn();
  const b = vi.fn();
  bus.subscribe(a);
  bus.subscribe(b);
  const ev: KernelEvent = { type: "proc.exit", pid: 1, exitCode: 0 };
  bus.emit(ev);
  expect(a).toHaveBeenCalledWith(ev);
  expect(b).toHaveBeenCalledWith(ev);
});

test("unsubscribe stops delivery", () => {
  const bus = new EventBus();
  const fn = vi.fn();
  const unsub = bus.subscribe(fn);
  unsub();
  bus.emit({ type: "fs.write", path: "/a", bytes: 3 });
  expect(fn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
export type KernelEvent =
  | { type: "syscall"; name: string; path?: string; ok: boolean; code?: string }
  | { type: "fs.write"; path: string; bytes: number }
  | { type: "proc.spawn"; pid: number; ppid: number; argv: string[] }
  | { type: "proc.exit"; pid: number; exitCode: number }
  | { type: "net.fetch"; url: string; method: string; status?: number };

export type KernelEventListener = (ev: KernelEvent) => void;

export class EventBus {
  #listeners = new Set<KernelEventListener>();

  emit(ev: KernelEvent): void {
    for (const fn of this.#listeners) fn(ev);
  }

  subscribe(fn: KernelEventListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/events.ts packages/kernel/test/events.test.ts
git commit -m "feat(kernel): typed event bus"
```

---

### Task 5: VFS — écriture, lecture, stat (`vfs.ts`)

**Files:**
- Create: `packages/kernel/src/vfs.ts`
- Test: `packages/kernel/test/vfs.test.ts`

Le contenu d'un fichier est `Uint8Array | LazyRef` dès maintenant (la Task 14 branchera l'hydratation) ; `readFile` est donc async dès le départ.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { KernelError } from "../src/errors.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeVfs() {
  let t = 1000;
  return new Vfs({ now: () => t++ });
}

test("write then read round-trip", async () => {
  const vfs = makeVfs();
  vfs.writeFile("/a.txt", enc.encode("hello"));
  expect(dec.decode(await vfs.readFile("/a.txt"))).toBe("hello");
});

test("read missing file → ENOENT", async () => {
  const vfs = makeVfs();
  await expect(vfs.readFile("/nope")).rejects.toMatchObject({ code: "ENOENT" });
});

test("read a directory → EISDIR", async () => {
  const vfs = makeVfs();
  vfs.mkdir("/d");
  await expect(vfs.readFile("/d")).rejects.toMatchObject({ code: "EISDIR" });
});

test("write requires existing parent dir", () => {
  const vfs = makeVfs();
  expect(() => vfs.writeFile("/no/such/file.txt", enc.encode("x"))).toThrowError(KernelError);
});

test("write over a directory → EISDIR", () => {
  const vfs = makeVfs();
  vfs.mkdir("/d");
  expect(() => vfs.writeFile("/d", enc.encode("x"))).toThrowError(/EISDIR/);
});

test("stat reports kind, size, mtime", () => {
  const vfs = makeVfs();
  vfs.writeFile("/a.txt", enc.encode("hello"));
  const s = vfs.stat("/a.txt");
  expect(s.kind).toBe("file");
  expect(s.size).toBe(5);
  expect(s.mtime).toBeGreaterThan(0);
  expect(vfs.stat("/").kind).toBe("dir");
});

test("exists", () => {
  const vfs = makeVfs();
  expect(vfs.exists("/")).toBe(true);
  expect(vfs.exists("/a")).toBe(false);
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import { KernelError } from "./errors.js";
import { normalizePath, parentOf } from "./path.js";

export type LazyRef = { hash: string; size: number };
export type FileEntry = { kind: "file"; content: Uint8Array | LazyRef; mtime: number };
export type DirEntry = { kind: "dir"; mtime: number };
export type Entry = FileEntry | DirEntry;
export type Stat = { kind: "file" | "dir"; size: number; mtime: number };
export type Hydrator = (hash: string) => Promise<Uint8Array>;

export function isLazy(content: Uint8Array | LazyRef): content is LazyRef {
  return !(content instanceof Uint8Array);
}

export class Vfs {
  #entries = new Map<string, Entry>();
  #now: () => number;
  /** Posé par restoreVfs : résout un hash de blob vers son contenu (Task 14). */
  hydrator: Hydrator | null = null;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#entries.set("/", { kind: "dir", mtime: this.#now() });
  }

  entry(path: string): Entry {
    const e = this.#entries.get(normalizePath(path));
    if (!e) throw new KernelError("ENOENT", path);
    return e;
  }

  exists(path: string): boolean {
    return this.#entries.has(normalizePath(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const e = this.entry(p);
    if (e.kind === "dir") throw new KernelError("EISDIR", p);
    if (isLazy(e.content)) {
      if (!this.hydrator) throw new KernelError("ENOENT", `no hydrator for blob ${e.content.hash}`);
      e.content = await this.hydrator(e.content.hash);
    }
    return e.content;
  }

  writeFile(path: string, content: Uint8Array): void {
    const p = normalizePath(path);
    const existing = this.#entries.get(p);
    if (existing?.kind === "dir") throw new KernelError("EISDIR", p);
    const parentPath = parentOf(p);
    const parent = this.#entries.get(parentPath);
    if (!parent) throw new KernelError("ENOENT", `parent ${parentPath}`);
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    this.#entries.set(p, { kind: "file", content, mtime: this.#now() });
  }

  stat(path: string): Stat {
    const e = this.entry(path);
    if (e.kind === "dir") return { kind: "dir", size: 0, mtime: e.mtime };
    const size = isLazy(e.content) ? e.content.size : e.content.byteLength;
    return { kind: "file", size, mtime: e.mtime };
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalizePath(path);
    const existing = this.#entries.get(p);
    if (existing) {
      if (existing.kind === "dir" && opts.recursive) return;
      throw new KernelError("EEXIST", p);
    }
    const parentPath = parentOf(p);
    if (!this.#entries.has(parentPath)) {
      if (!opts.recursive) throw new KernelError("ENOENT", `parent ${parentPath}`);
      this.mkdir(parentPath, opts);
    }
    const parent = this.#entries.get(parentPath)!;
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    this.#entries.set(p, { kind: "dir", mtime: this.#now() });
  }

  /** Itère toutes les entrées (paths canoniques) — utilisé par snapshot. */
  files(): IterableIterator<[string, Entry]> {
    return this.#entries.entries();
  }
}
```

Note : `mkdir` est déjà inclus ici car les tests de lecture/EISDIR en ont besoin. La Task 6 complète `readdir`/`rm`/`rename`/`totalBytes` — ces méthodes s'ajoutent dans la même classe et accèdent directement à `this.#entries`.

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/vfs.ts packages/kernel/test/vfs.test.ts
git commit -m "feat(kernel): in-memory VFS — write/read/stat/mkdir"
```

---

### Task 6: VFS — readdir, rm, rename, totalBytes

**Files:**
- Modify: `packages/kernel/src/vfs.ts`
- Test: `packages/kernel/test/vfs-tree.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function seeded() {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/work");
  vfs.mkdir("/work/sub");
  vfs.writeFile("/work/a.txt", enc.encode("aa"));
  vfs.writeFile("/work/sub/b.txt", enc.encode("bbbb"));
  return vfs;
}

test("readdir lists direct children, sorted", () => {
  const vfs = seeded();
  expect(vfs.readdir("/work")).toEqual(["a.txt", "sub"]);
  expect(vfs.readdir("/")).toEqual(["work"]);
});

test("readdir on a file → ENOTDIR", () => {
  const vfs = seeded();
  expect(() => vfs.readdir("/work/a.txt")).toThrowError(/ENOTDIR/);
});

test("rm file, rm dir requires recursive when non-empty", () => {
  const vfs = seeded();
  vfs.rm("/work/a.txt");
  expect(vfs.exists("/work/a.txt")).toBe(false);
  expect(() => vfs.rm("/work")).toThrowError(/ENOTEMPTY/);
  vfs.rm("/work", { recursive: true });
  expect(vfs.exists("/work")).toBe(false);
  expect(vfs.exists("/work/sub/b.txt")).toBe(false);
});

test("rm / is forbidden", () => {
  const vfs = seeded();
  expect(() => vfs.rm("/")).toThrowError(/EINVAL/);
});

test("rename moves a file", async () => {
  const vfs = seeded();
  vfs.rename("/work/a.txt", "/work/c.txt");
  expect(vfs.exists("/work/a.txt")).toBe(false);
  expect(dec.decode(await vfs.readFile("/work/c.txt"))).toBe("aa");
});

test("rename moves a whole subtree", async () => {
  const vfs = seeded();
  vfs.rename("/work", "/done");
  expect(dec.decode(await vfs.readFile("/done/sub/b.txt"))).toBe("bbbb");
  expect(vfs.exists("/work")).toBe(false);
});

test("totalBytes sums file sizes", () => {
  const vfs = seeded();
  expect(vfs.totalBytes()).toBe(6); // "aa" + "bbbb"
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter** — ajouter à la classe `Vfs` :

```ts
  readdir(path: string): string[] {
    const p = normalizePath(path);
    const e = this.entry(p);
    if (e.kind !== "dir") throw new KernelError("ENOTDIR", p);
    const prefix = p === "/" ? "/" : p + "/";
    const names: string[] = [];
    for (const key of this.#entries.keys()) {
      if (key === p || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes("/")) names.push(rest);
    }
    return names.sort();
  }

  rm(path: string, opts: { recursive?: boolean } = {}): void {
    const p = normalizePath(path);
    if (p === "/") throw new KernelError("EINVAL", "cannot remove /");
    const e = this.entry(p);
    if (e.kind === "dir") {
      const children = this.readdir(p);
      if (children.length > 0 && !opts.recursive) throw new KernelError("ENOTEMPTY", p);
      for (const child of children) this.rm(`${p}/${child}`, opts);
    }
    this.#entries.delete(p);
  }

  rename(from: string, to: string): void {
    const f = normalizePath(from);
    const t = normalizePath(to);
    const e = this.entry(f);
    const parentPath = parentOf(t);
    const parent = this.#entries.get(parentPath);
    if (!parent) throw new KernelError("ENOENT", `parent ${parentPath}`);
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentPath);
    const moves: Array<[string, string]> = [[f, t]];
    if (e.kind === "dir") {
      const prefix = f + "/";
      for (const key of this.#entries.keys()) {
        if (key.startsWith(prefix)) moves.push([key, t + key.slice(f.length)]);
      }
    }
    for (const [oldKey, newKey] of moves) {
      const entry = this.#entries.get(oldKey)!;
      this.#entries.delete(oldKey);
      this.#entries.set(newKey, entry);
    }
  }

  totalBytes(): number {
    let total = 0;
    for (const e of this.#entries.values()) {
      if (e.kind === "file") total += isLazy(e.content) ? e.content.size : e.content.byteLength;
    }
    return total;
  }
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/vfs.ts packages/kernel/test/vfs-tree.test.ts
git commit -m "feat(kernel): VFS readdir/rm/rename/totalBytes"
```

---

### Task 7: Frontière syscall + chaîne de middlewares (`syscalls.ts`)

**Files:**
- Create: `packages/kernel/src/syscalls.ts`
- Test: `packages/kernel/test/syscalls.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls, type Middleware, type SyscallDescriptor } from "../src/syscalls.js";

const dec = new TextDecoder();

test("syscalls delegate to vfs", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const sys = createSyscalls({ vfs, middlewares: [] });
  await sys.mkdir("/d");
  await sys.writeFile("/d/a.txt", "hi");
  expect(dec.decode(await sys.readFile("/d/a.txt"))).toBe("hi");
  expect((await sys.stat("/d/a.txt")).size).toBe(2);
  expect(await sys.readdir("/d")).toEqual(["a.txt"]);
  await sys.rename("/d/a.txt", "/d/b.txt");
  await sys.rm("/d/b.txt");
  expect(vfs.exists("/d/b.txt")).toBe(false);
});

test("middlewares wrap every call, in order, with a normalized descriptor", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const seen: string[] = [];
  const mw =
    (tag: string): Middleware =>
    async (call: SyscallDescriptor, next) => {
      seen.push(`${tag}:${call.name}:${call.path ?? ""}`);
      return next();
    };
  const sys = createSyscalls({ vfs, middlewares: [mw("outer"), mw("inner")] });
  await sys.writeFile("a.txt", "x"); // chemin relatif → normalisé vers /a.txt
  expect(seen).toEqual(["outer:writeFile:/a.txt", "inner:writeFile:/a.txt"]);
});

test("descriptor carries write flag and byte count", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const calls: SyscallDescriptor[] = [];
  const spy: Middleware = async (call, next) => {
    calls.push({ ...call });
    return next();
  };
  const sys = createSyscalls({ vfs, middlewares: [spy] });
  await sys.writeFile("/a.txt", "hello");
  await sys.readFile("/a.txt");
  expect(calls[0]).toMatchObject({ name: "writeFile", write: true, bytes: 5 });
  expect(calls[1]).toMatchObject({ name: "readFile", write: false });
});

test("fetch goes through middlewares and fetchImpl", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const calls: SyscallDescriptor[] = [];
  const spy: Middleware = async (call, next) => {
    calls.push({ ...call });
    return next();
  };
  const sys = createSyscalls({ vfs, middlewares: [spy], fetchImpl });
  const res = await sys.fetch("https://api.example.com/x");
  expect(await res.text()).toBe("ok");
  expect(calls[0]).toMatchObject({ name: "fetch", url: "https://api.example.com/x" });
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import type { Stat, Vfs } from "./vfs.js";
import { normalizePath } from "./path.js";

export type SyscallName =
  | "readFile"
  | "writeFile"
  | "stat"
  | "readdir"
  | "mkdir"
  | "rm"
  | "rename"
  | "fetch";

export interface SyscallDescriptor {
  name: SyscallName;
  /** Chemin principal, déjà normalisé. Absent pour fetch. */
  path?: string;
  /** Cible d'un rename, normalisée. */
  toPath?: string;
  /** URL pour fetch. */
  url?: string;
  /** Taille du payload pour writeFile. */
  bytes?: number;
  /** L'appel mute-t-il le FS ? */
  write: boolean;
}

export type Middleware = (call: SyscallDescriptor, next: () => Promise<unknown>) => Promise<unknown>;

export interface FsSyscalls {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<Stat>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export function createSyscalls(opts: {
  vfs: Vfs;
  middlewares: Middleware[];
  fetchImpl?: typeof fetch;
}): FsSyscalls {
  const { vfs, middlewares } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const enc = new TextEncoder();

  function run<T>(call: SyscallDescriptor, impl: () => Promise<T>): Promise<T> {
    let next: () => Promise<unknown> = impl;
    for (let i = middlewares.length - 1; i >= 0; i--) {
      const mw = middlewares[i]!;
      const inner = next;
      next = () => mw(call, inner);
    }
    return next() as Promise<T>;
  }

  return {
    readFile: (path) =>
      run({ name: "readFile", path: normalizePath(path), write: false }, () => vfs.readFile(path)),
    writeFile: (path, content) => {
      const data = typeof content === "string" ? enc.encode(content) : content;
      return run(
        { name: "writeFile", path: normalizePath(path), bytes: data.byteLength, write: true },
        async () => vfs.writeFile(path, data),
      );
    },
    stat: (path) =>
      run({ name: "stat", path: normalizePath(path), write: false }, async () => vfs.stat(path)),
    readdir: (path) =>
      run({ name: "readdir", path: normalizePath(path), write: false }, async () => vfs.readdir(path)),
    mkdir: (path, o) =>
      run({ name: "mkdir", path: normalizePath(path), write: true }, async () => vfs.mkdir(path, o)),
    rm: (path, o) =>
      run({ name: "rm", path: normalizePath(path), write: true }, async () => vfs.rm(path, o)),
    rename: (from, to) =>
      run(
        { name: "rename", path: normalizePath(from), toPath: normalizePath(to), write: true },
        async () => vfs.rename(from, to),
      ),
    fetch: (url, init) =>
      run({ name: "fetch", url, write: false }, () => fetchImpl(url, init)),
  };
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/syscalls.ts packages/kernel/test/syscalls.test.ts
git commit -m "feat(kernel): syscall boundary with middleware chain"
```

---

### Task 8: Middleware permissions (`middleware/permissions.ts`)

**Files:**
- Create: `packages/kernel/src/middleware/permissions.ts`
- Test: `packages/kernel/test/permissions.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { permissionsMiddleware } from "../src/middleware/permissions.js";

function makeSys(cfg: Parameters<typeof permissionsMiddleware>[0]) {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/knowledge");
  vfs.writeFile("/knowledge/doc.md", new TextEncoder().encode("ro"));
  vfs.mkdir("/work");
  return createSyscalls({ vfs, middlewares: [permissionsMiddleware(cfg)] });
}

test("writes under a ro mount → EACCES; reads still allowed", async () => {
  const sys = makeSys({ mounts: [{ path: "/knowledge", mode: "ro" }] });
  await expect(sys.writeFile("/knowledge/x.txt", "x")).rejects.toMatchObject({ code: "EACCES" });
  await expect(sys.rm("/knowledge/doc.md")).rejects.toMatchObject({ code: "EACCES" });
  await expect(sys.readFile("/knowledge/doc.md")).resolves.toBeInstanceOf(Uint8Array);
  await expect(sys.writeFile("/work/ok.txt", "x")).resolves.toBeUndefined();
});

test("rename out of or into a ro mount → EACCES", async () => {
  const sys = makeSys({ mounts: [{ path: "/knowledge", mode: "ro" }] });
  await expect(sys.rename("/knowledge/doc.md", "/work/doc.md")).rejects.toMatchObject({ code: "EACCES" });
  await sys.writeFile("/work/a.txt", "a");
  await expect(sys.rename("/work/a.txt", "/knowledge/a.txt")).rejects.toMatchObject({ code: "EACCES" });
});

test("network off by default → ENETBLOCKED", async () => {
  const sys = makeSys({});
  await expect(sys.fetch("https://example.com")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});

test("fetch allowed only on allow-listed prefixes", async () => {
  const vfs = new Vfs({ now: () => 1 });
  const fetchImpl = (async () => new Response("ok")) as typeof fetch;
  const sys = createSyscalls({
    vfs,
    fetchImpl,
    middlewares: [permissionsMiddleware({ network: { allowedUrlPrefixes: ["https://api.example.com/"] } })],
  });
  await expect(sys.fetch("https://api.example.com/v1/x")).resolves.toBeInstanceOf(Response);
  await expect(sys.fetch("https://evil.com/")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import { KernelError } from "../errors.js";
import { normalizePath } from "../path.js";
import type { Middleware } from "../syscalls.js";

export interface PermissionsConfig {
  /** Sous-arbres en lecture seule. Tout le reste est rw par défaut. */
  mounts?: Array<{ path: string; mode: "ro" | "rw" }>;
  /** Réseau : absent = tout bloqué. */
  network?: { allowedUrlPrefixes: string[] };
}

export function permissionsMiddleware(cfg: PermissionsConfig): Middleware {
  const mounts = (cfg.mounts ?? []).map((m) => ({ mode: m.mode, path: normalizePath(m.path) }));

  function isReadOnly(path: string): boolean {
    let best: { path: string; mode: "ro" | "rw" } | null = null;
    for (const m of mounts) {
      const prefix = m.path === "/" ? "/" : m.path + "/";
      if (path === m.path || path.startsWith(prefix)) {
        if (!best || m.path.length > best.path.length) best = m;
      }
    }
    return best?.mode === "ro";
  }

  return async (call, next) => {
    if (call.name === "fetch") {
      const allowed = cfg.network?.allowedUrlPrefixes ?? [];
      if (!allowed.some((prefix) => call.url!.startsWith(prefix))) {
        throw new KernelError("ENETBLOCKED", call.url ?? "<no url>");
      }
      return next();
    }
    if (call.write) {
      if (call.path && isReadOnly(call.path)) throw new KernelError("EACCES", `read-only: ${call.path}`);
      if (call.toPath && isReadOnly(call.toPath)) throw new KernelError("EACCES", `read-only: ${call.toPath}`);
    }
    return next();
  };
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/middleware/permissions.ts packages/kernel/test/permissions.test.ts
git commit -m "feat(kernel): permissions middleware — ro mounts + network allow-list"
```

---

### Task 9: Middleware quotas (`middleware/quotas.ts`)

**Files:**
- Create: `packages/kernel/src/middleware/quotas.ts`
- Test: `packages/kernel/test/quotas.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { QuotaTracker, quotasMiddleware, DEFAULT_LIMITS } from "../src/middleware/quotas.js";

function makeSys(limits: Partial<typeof DEFAULT_LIMITS>) {
  const vfs = new Vfs({ now: () => 1 });
  const tracker = new QuotaTracker({ ...DEFAULT_LIMITS, ...limits }, vfs);
  const sys = createSyscalls({ vfs, middlewares: [quotasMiddleware(tracker)] });
  return { sys, tracker };
}

test("maxFileSize enforced on write", async () => {
  const { sys } = makeSys({ maxFileSize: 4 });
  await expect(sys.writeFile("/big.txt", "12345")).rejects.toMatchObject({ code: "EQUOTA" });
  await expect(sys.writeFile("/ok.txt", "1234")).resolves.toBeUndefined();
});

test("maxFsBytes enforced on cumulative writes", async () => {
  const { sys } = makeSys({ maxFsBytes: 6 });
  await sys.writeFile("/a.txt", "1234");
  await expect(sys.writeFile("/b.txt", "567")).rejects.toMatchObject({ code: "EQUOTA" });
});

test("maxSyscallsPerTurn enforced, resetTurn() clears the counter", async () => {
  const { sys, tracker } = makeSys({ maxSyscallsPerTurn: 2 });
  await sys.writeFile("/a.txt", "x");
  await sys.readFile("/a.txt");
  await expect(sys.readFile("/a.txt")).rejects.toMatchObject({ code: "EQUOTA" });
  tracker.resetTurn();
  await expect(sys.readFile("/a.txt")).resolves.toBeInstanceOf(Uint8Array);
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import { KernelError } from "../errors.js";
import type { Middleware } from "../syscalls.js";
import type { Vfs } from "../vfs.js";

export interface Limits {
  maxFsBytes: number;
  maxFileSize: number;
  maxSyscallsPerTurn: number;
  maxProcs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFsBytes: 64 * 1024 * 1024,
  maxFileSize: 8 * 1024 * 1024,
  maxSyscallsPerTurn: 10_000,
  maxProcs: 64,
};

export class QuotaTracker {
  syscallCount = 0;

  constructor(
    readonly limits: Limits,
    readonly vfs: Vfs,
  ) {}

  resetTurn(): void {
    this.syscallCount = 0;
  }
}

export function quotasMiddleware(tracker: QuotaTracker): Middleware {
  return async (call, next) => {
    tracker.syscallCount++;
    if (tracker.syscallCount > tracker.limits.maxSyscallsPerTurn) {
      throw new KernelError("EQUOTA", `maxSyscallsPerTurn (${tracker.limits.maxSyscallsPerTurn}) exceeded`);
    }
    if (call.name === "writeFile" && call.bytes !== undefined) {
      if (call.bytes > tracker.limits.maxFileSize) {
        throw new KernelError("EQUOTA", `maxFileSize (${tracker.limits.maxFileSize}) exceeded`);
      }
      // Pessimiste sur overwrite : on ne déduit pas l'ancienne taille. Simple et sûr.
      if (tracker.vfs.totalBytes() + call.bytes > tracker.limits.maxFsBytes) {
        throw new KernelError("EQUOTA", `maxFsBytes (${tracker.limits.maxFsBytes}) exceeded`);
      }
    }
    return next();
  };
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/middleware/quotas.ts packages/kernel/test/quotas.test.ts
git commit -m "feat(kernel): quotas middleware — fs bytes, file size, syscalls per turn"
```

---

### Task 10: Middleware trace (`middleware/trace.ts`)

**Files:**
- Create: `packages/kernel/src/middleware/trace.ts`
- Test: `packages/kernel/test/trace.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { Vfs } from "../src/vfs.js";
import { createSyscalls } from "../src/syscalls.js";
import { EventBus, type KernelEvent } from "../src/events.js";
import { traceMiddleware } from "../src/middleware/trace.js";
import { permissionsMiddleware } from "../src/middleware/permissions.js";

function makeTraced() {
  const vfs = new Vfs({ now: () => 1 });
  const bus = new EventBus();
  const events: KernelEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  // trace OUTERMOST : capture aussi les refus des middlewares internes
  const sys = createSyscalls({
    vfs,
    middlewares: [traceMiddleware(bus), permissionsMiddleware({ mounts: [{ path: "/ro", mode: "ro" }] })],
  });
  vfs.mkdir("/ro");
  return { sys, events };
}

test("successful syscall emits syscall + fs.write events", async () => {
  const { sys, events } = makeTraced();
  await sys.writeFile("/a.txt", "abc");
  expect(events).toContainEqual({ type: "syscall", name: "writeFile", path: "/a.txt", ok: true });
  expect(events).toContainEqual({ type: "fs.write", path: "/a.txt", bytes: 3 });
});

test("failed syscall emits ok:false with errno code, error still thrown", async () => {
  const { sys, events } = makeTraced();
  await expect(sys.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
  expect(events).toContainEqual({ type: "syscall", name: "readFile", path: "/missing", ok: false, code: "ENOENT" });
});

test("permission denials are traced (trace is outermost)", async () => {
  const { sys, events } = makeTraced();
  await expect(sys.writeFile("/ro/x.txt", "x")).rejects.toMatchObject({ code: "EACCES" });
  expect(events).toContainEqual({ type: "syscall", name: "writeFile", path: "/ro/x.txt", ok: false, code: "EACCES" });
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

```ts
import { isKernelError } from "../errors.js";
import type { EventBus } from "../events.js";
import type { Middleware } from "../syscalls.js";

export function traceMiddleware(bus: EventBus): Middleware {
  return async (call, next) => {
    const path = call.path ?? call.url;
    try {
      const result = await next();
      bus.emit({ type: "syscall", name: call.name, path, ok: true });
      if (call.name === "writeFile" && call.path !== undefined && call.bytes !== undefined) {
        bus.emit({ type: "fs.write", path: call.path, bytes: call.bytes });
      }
      return result;
    } catch (err) {
      bus.emit({
        type: "syscall",
        name: call.name,
        path,
        ok: false,
        code: isKernelError(err) ? err.code : "UNKNOWN",
      });
      throw err;
    }
  };
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/middleware/trace.ts packages/kernel/test/trace.test.ts
git commit -m "feat(kernel): trace middleware — every syscall (incl. denials) on the event bus"
```

---

### Task 11: Utilitaires streams + ProcTable spawn/wait (`streams.ts`, `proc.ts`)

**Files:**
- Create: `packages/kernel/src/streams.ts`, `packages/kernel/src/proc.ts`
- Test: `packages/kernel/test/proc.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { ProcTable, type ProcIo } from "../src/proc.js";
import { EventBus, type KernelEvent } from "../src/events.js";
import { readText, writeAll } from "../src/streams.js";

function makeTable() {
  const bus = new EventBus();
  const events: KernelEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  return { table: new ProcTable({ bus, maxProcs: 8 }), events };
}

const echoMain = (text: string) => async (io: ProcIo) => {
  await writeAll(io.stdout, text);
  return 0;
};

test("spawn runs main, stdout readable, exit code via wait", async () => {
  const { table } = makeTable();
  const proc = table.spawn(["echo", "hi"], echoMain("hi\n"));
  expect(proc.pid).toBe(1);
  expect(await readText(proc.stdout)).toBe("hi\n");
  expect(await table.wait(proc.pid)).toBe(0);
});

test("main receives argv and can read stdin", async () => {
  const { table } = makeTable();
  // un `cat` virtuel : copie stdin vers stdout
  const proc = table.spawn(["cat"], async (io) => {
    for await (const chunk of io.stdin) {
      const w = io.stdout.getWriter();
      await w.write(chunk);
      w.releaseLock();
    }
    return 0;
  });
  await writeAll(proc.stdin, "via stdin");
  await proc.stdin.close();
  expect(await readText(proc.stdout)).toBe("via stdin");
  expect(await proc.exit).toBe(0);
});

test("throwing main → exit 1, message on stderr", async () => {
  const { table } = makeTable();
  const proc = table.spawn(["boom"], async () => {
    throw new Error("kaput");
  });
  expect(await proc.exit).toBe(1);
  expect(await readText(proc.stderr)).toContain("kaput");
});

test("spawn/exit events emitted", async () => {
  const { table, events } = makeTable();
  const proc = table.spawn(["echo"], echoMain(""));
  await proc.exit;
  expect(events).toContainEqual({ type: "proc.spawn", pid: proc.pid, ppid: 0, argv: ["echo"] });
  expect(events).toContainEqual({ type: "proc.exit", pid: proc.pid, exitCode: 0 });
});

test("wait on unknown pid → ENOENT (throw synchrone)", () => {
  const { table } = makeTable();
  expect(() => table.wait(999)).toThrowError(/ENOENT/);
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

`packages/kernel/src/streams.ts`:
```ts
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return dec.decode(await readAll(stream));
}

export async function writeAll(stream: WritableStream<Uint8Array>, data: Uint8Array | string): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(typeof data === "string" ? enc.encode(data) : data);
  } finally {
    writer.releaseLock();
  }
}
```

`packages/kernel/src/proc.ts`:
```ts
import { KernelError } from "./errors.js";
import type { EventBus } from "./events.js";

export interface ProcIo {
  argv: string[];
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}

export type ProcMain = (io: ProcIo) => Promise<number | void>;
export type ProcStatus = "running" | "exited";

export interface ProcHandle {
  pid: number;
  ppid: number;
  argv: string[];
  /** Côté écriture : le parent alimente le stdin du proc. */
  stdin: WritableStream<Uint8Array>;
  /** Côtés lecture : le parent consomme stdout/stderr. */
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exit: Promise<number>;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  argv: string[];
  status: ProcStatus;
  exitCode: number | null;
}

interface ProcRecord {
  handle: ProcHandle;
  status: ProcStatus;
  exitCode: number | null;
}

export class ProcTable {
  #nextPid = 1;
  #procs = new Map<number, ProcRecord>();
  #bus: EventBus;
  #maxProcs: number;

  constructor(opts: { bus: EventBus; maxProcs?: number }) {
    this.#bus = opts.bus;
    this.#maxProcs = opts.maxProcs ?? Infinity;
  }

  spawn(argv: string[], main: ProcMain, opts: { ppid?: number } = {}): ProcHandle {
    let running = 0;
    for (const p of this.#procs.values()) if (p.status === "running") running++;
    if (running >= this.#maxProcs) throw new KernelError("EQUOTA", `maxProcs (${this.#maxProcs}) exceeded`);

    const pid = this.#nextPid++;
    const ppid = opts.ppid ?? 0;
    const stdin = new TransformStream<Uint8Array, Uint8Array>();
    const stdout = new TransformStream<Uint8Array, Uint8Array>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();

    const record: ProcRecord = { handle: null as unknown as ProcHandle, status: "running", exitCode: null };

    const exit = (async () => {
      let code: number;
      try {
        code = (await main({ argv, stdin: stdin.readable, stdout: stdout.writable, stderr: stderr.writable })) ?? 0;
      } catch (err) {
        code = 1;
        try {
          const writer = stderr.writable.getWriter();
          const msg = err instanceof Error ? err.message : String(err);
          await writer.write(new TextEncoder().encode(msg + "\n"));
          writer.releaseLock();
        } catch {
          // stderr déjà verrouillé ou fermé par main — tant pis pour le message
        }
      }
      for (const side of [stdout.writable, stderr.writable]) {
        try {
          await side.close();
        } catch {
          // déjà fermé par main
        }
      }
      record.status = "exited";
      record.exitCode = code;
      this.#bus.emit({ type: "proc.exit", pid, exitCode: code });
      return code;
    })();

    const handle: ProcHandle = {
      pid,
      ppid,
      argv,
      stdin: stdin.writable,
      stdout: stdout.readable,
      stderr: stderr.readable,
      exit,
    };
    record.handle = handle;
    this.#procs.set(pid, record);
    this.#bus.emit({ type: "proc.spawn", pid, ppid, argv });
    return handle;
  }

  wait(pid: number): Promise<number> {
    const record = this.#procs.get(pid);
    if (!record) throw new KernelError("ENOENT", `pid ${pid}`);
    return record.handle.exit;
  }

  list(): ProcInfo[] {
    return [...this.#procs.values()].map((r) => ({
      pid: r.handle.pid,
      ppid: r.handle.ppid,
      argv: r.handle.argv,
      status: r.status,
      exitCode: r.exitCode,
    }));
  }
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/streams.ts packages/kernel/src/proc.ts packages/kernel/test/proc.test.ts
git commit -m "feat(kernel): virtual process table with Web Streams stdio"
```

---

### Task 12: Pipes entre procs + quota maxProcs

**Files:**
- Modify: `packages/kernel/src/proc.ts`
- Test: `packages/kernel/test/pipe.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { ProcTable, type ProcIo } from "../src/proc.js";
import { EventBus } from "../src/events.js";
import { readText, writeAll } from "../src/streams.js";

function makeTable(maxProcs = 8) {
  return new ProcTable({ bus: new EventBus(), maxProcs });
}

const upperMain = async (io: ProcIo) => {
  for await (const chunk of io.stdin) {
    const text = new TextDecoder().decode(chunk).toUpperCase();
    const w = io.stdout.getWriter();
    await w.write(new TextEncoder().encode(text));
    w.releaseLock();
  }
  return 0;
};

test("pipe connects producer stdout to consumer stdin", async () => {
  const table = makeTable();
  const producer = table.spawn(["echo"], async (io) => {
    await writeAll(io.stdout, "hello pipe");
    return 0;
  });
  const consumer = table.spawn(["upper"], upperMain);
  table.pipe(producer, consumer);
  expect(await readText(consumer.stdout)).toBe("HELLO PIPE");
  expect(await consumer.exit).toBe(0);
});

test("maxProcs exceeded → EQUOTA", async () => {
  const table = makeTable(1);
  const blocker = table.spawn(["sleep"], async (io) => {
    await readText(io.stdin); // bloque jusqu'à fermeture du stdin
    return 0;
  });
  expect(() => table.spawn(["echo"], upperMain)).toThrowError(/EQUOTA/);
  await blocker.stdin.close();
  await blocker.exit;
  // un slot s'est libéré
  const next = table.spawn(["echo"], async () => 0);
  expect(await next.exit).toBe(0);
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL (`pipe` manquant ; le test maxProcs passe déjà — c'est attendu, il verrouille le comportement).

- [ ] **Step 3: Implémenter** — ajouter à `ProcTable` :

```ts
  /** Connecte stdout de `from` au stdin de `to`. Fire-and-forget : la fin du
   *  producteur ferme le stdin du consommateur. Les erreurs de pipe (consommateur
   *  mort) sont volontairement avalées — sémantique SIGPIPE simplifiée. */
  pipe(from: ProcHandle, to: ProcHandle): void {
    void from.stdout.pipeTo(to.stdin).catch(() => {});
  }
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/proc.ts packages/kernel/test/pipe.test.ts
git commit -m "feat(kernel): proc pipes + maxProcs quota"
```

---

### Task 13: Hash + stores de snapshots (`snapshot/hash.ts`, `snapshot/store.ts`, `snapshot/disk-store.ts`)

**Files:**
- Create: `packages/kernel/src/snapshot/hash.ts`, `packages/kernel/src/snapshot/store.ts`, `packages/kernel/src/snapshot/disk-store.ts`
- Test: `packages/kernel/test/store.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/snapshot/hash.js";
import { MemorySnapshotStore, type SnapshotManifest } from "../src/snapshot/store.js";
import { DiskSnapshotStore } from "../src/snapshot/disk-store.js";

const enc = new TextEncoder();

test("sha256Hex is deterministic and matches known vector", async () => {
  // echo -n "abc" | shasum -a 256
  expect(await sha256Hex(enc.encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

const manifest: SnapshotManifest = {
  version: 1,
  entries: { "/a.txt": { kind: "file", hash: "h1", size: 2, mtime: 1 } },
  meta: { turn: 3 },
};

test("MemorySnapshotStore blob + tree round-trip", async () => {
  const store = new MemorySnapshotStore();
  expect(await store.hasBlob("h1")).toBe(false);
  expect(await store.getBlob("h1")).toBeNull();
  await store.putBlob("h1", enc.encode("hi"));
  expect(await store.hasBlob("h1")).toBe(true);
  expect(new TextDecoder().decode((await store.getBlob("h1"))!)).toBe("hi");
  await store.putTree("snap1", manifest);
  expect(await store.getTree("snap1")).toEqual(manifest);
  expect(await store.getTree("nope")).toBeNull();
});

test("DiskSnapshotStore blob + tree round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-store-"));
  try {
    const store = new DiskSnapshotStore(dir);
    await store.putBlob("h1", enc.encode("hi"));
    expect(await store.hasBlob("h1")).toBe(true);
    expect(await store.getBlob("h2")).toBeNull();
    expect(new TextDecoder().decode((await store.getBlob("h1"))!)).toBe("hi");
    await store.putTree("snap1", manifest);
    expect(await store.getTree("snap1")).toEqual(manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

`packages/kernel/src/snapshot/hash.ts`:
```ts
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

`packages/kernel/src/snapshot/store.ts`:
```ts
export type ManifestEntry =
  | { kind: "file"; hash: string; size: number; mtime: number }
  | { kind: "dir"; mtime: number };

export interface SnapshotManifest {
  version: 1;
  /** path canonique → entrée. Les clés DOIVENT être insérées triées (déterminisme de l'id). */
  entries: Record<string, ManifestEntry>;
  /** Métadonnées opaques (ex. historique de conversation du harness). */
  meta?: unknown;
}

export interface SnapshotStore {
  putBlob(hash: string, data: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | null>;
  hasBlob(hash: string): Promise<boolean>;
  putTree(id: string, manifest: SnapshotManifest): Promise<void>;
  getTree(id: string): Promise<SnapshotManifest | null>;
}

export class MemorySnapshotStore implements SnapshotStore {
  #blobs = new Map<string, Uint8Array>();
  #trees = new Map<string, string>(); // JSON sérialisé, immuable

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    this.#blobs.set(hash, data);
  }
  async getBlob(hash: string): Promise<Uint8Array | null> {
    return this.#blobs.get(hash) ?? null;
  }
  async hasBlob(hash: string): Promise<boolean> {
    return this.#blobs.has(hash);
  }
  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    this.#trees.set(id, JSON.stringify(manifest));
  }
  async getTree(id: string): Promise<SnapshotManifest | null> {
    const json = this.#trees.get(id);
    return json ? (JSON.parse(json) as SnapshotManifest) : null;
  }
}
```

`packages/kernel/src/snapshot/disk-store.ts`:
```ts
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotManifest, SnapshotStore } from "./store.js";

/** Store sur disque local : blobs/<hash>, trees/<id>.json. Pour dev et tests. */
export class DiskSnapshotStore implements SnapshotStore {
  constructor(private rootDir: string) {}

  #blobPath(hash: string): string {
    return join(this.rootDir, "blobs", hash);
  }
  #treePath(id: string): string {
    return join(this.rootDir, "trees", `${id}.json`);
  }

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    await mkdir(join(this.rootDir, "blobs"), { recursive: true });
    await writeFile(this.#blobPath(hash), data);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#blobPath(hash)));
    } catch {
      return null;
    }
  }

  async hasBlob(hash: string): Promise<boolean> {
    try {
      await access(this.#blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    await mkdir(join(this.rootDir, "trees"), { recursive: true });
    await writeFile(this.#treePath(id), JSON.stringify(manifest));
  }

  async getTree(id: string): Promise<SnapshotManifest | null> {
    try {
      return JSON.parse(await readFile(this.#treePath(id), "utf8")) as SnapshotManifest;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/snapshot packages/kernel/test/store.test.ts
git commit -m "feat(kernel): sha256 + memory/disk snapshot stores"
```

---

### Task 14: Snapshot / restore content-addressed avec hydratation lazy (`snapshot/snapshot.ts`)

**Files:**
- Create: `packages/kernel/src/snapshot/snapshot.ts`
- Modify: `packages/kernel/src/vfs.ts` (ajout de `putLazyFile`)
- Test: `packages/kernel/test/snapshot.test.ts`

- [ ] **Step 1: Ajouter `putLazyFile` au Vfs** (pas de test dédié — couvert par les tests de restore ci-dessous)

Dans `packages/kernel/src/vfs.ts`, ajouter à la classe `Vfs` :
```ts
  /** Installe un fichier non hydraté (restore lazy). Le parent doit exister. */
  putLazyFile(path: string, ref: LazyRef, mtime: number): void {
    const p = normalizePath(path);
    const parent = this.#entries.get(parentOf(p));
    if (!parent) throw new KernelError("ENOENT", `parent ${parentOf(p)}`);
    if (parent.kind !== "dir") throw new KernelError("ENOTDIR", parentOf(p));
    this.#entries.set(p, { kind: "file", content: ref, mtime });
  }
```

- [ ] **Step 2: Écrire le test qui échoue**

```ts
import { expect, test, vi } from "vitest";
import { Vfs } from "../src/vfs.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";
import { snapshotVfs, restoreVfs } from "../src/snapshot/snapshot.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function seeded() {
  const vfs = new Vfs({ now: () => 1 });
  vfs.mkdir("/work");
  vfs.writeFile("/work/a.txt", enc.encode("alpha"));
  vfs.writeFile("/work/b.txt", enc.encode("beta"));
  return vfs;
}

test("snapshot then restore yields identical content", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store, { meta: { turn: 1 } });
  const { vfs: restored, meta } = await restoreVfs(store, snapshotId, { now: () => 2 });
  expect(dec.decode(await restored.readFile("/work/a.txt"))).toBe("alpha");
  expect(restored.readdir("/work")).toEqual(["a.txt", "b.txt"]);
  expect(meta).toEqual({ turn: 1 });
});

test("same FS content → same snapshotId (deterministic, content-addressed)", async () => {
  const s1 = await snapshotVfs(seeded(), new MemorySnapshotStore());
  const s2 = await snapshotVfs(seeded(), new MemorySnapshotStore());
  expect(s1.snapshotId).toBe(s2.snapshotId);
});

test("incremental: unchanged blobs are not re-uploaded", async () => {
  const store = new MemorySnapshotStore();
  const putBlob = vi.spyOn(store, "putBlob");
  const vfs = seeded();
  await snapshotVfs(vfs, store);
  expect(putBlob).toHaveBeenCalledTimes(2); // a.txt + b.txt
  putBlob.mockClear();
  vfs.writeFile("/work/c.txt", enc.encode("gamma"));
  await snapshotVfs(vfs, store);
  expect(putBlob).toHaveBeenCalledTimes(1); // seulement c.txt
});

test("restore is lazy: blobs fetched only on first read; stat needs no fetch", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store);
  const getBlob = vi.spyOn(store, "getBlob");
  const { vfs: restored } = await restoreVfs(store, snapshotId);
  expect(getBlob).not.toHaveBeenCalled();
  expect(restored.stat("/work/a.txt").size).toBe(5); // taille depuis le manifest
  expect(getBlob).not.toHaveBeenCalled();
  await restored.readFile("/work/a.txt");
  expect(getBlob).toHaveBeenCalledTimes(1);
  await restored.readFile("/work/a.txt"); // hydraté : pas de re-fetch
  expect(getBlob).toHaveBeenCalledTimes(1);
});

test("snapshot of a restored-lazy vfs reuses hashes without hydrating", async () => {
  const store = new MemorySnapshotStore();
  const { snapshotId } = await snapshotVfs(seeded(), store);
  const { vfs: restored } = await restoreVfs(store, snapshotId);
  const getBlob = vi.spyOn(store, "getBlob");
  const { snapshotId: again } = await snapshotVfs(restored, store);
  expect(again).toBe(snapshotId);
  expect(getBlob).not.toHaveBeenCalled();
});

test("restore unknown id → ENOENT", async () => {
  await expect(restoreVfs(new MemorySnapshotStore(), "nope")).rejects.toMatchObject({ code: "ENOENT" });
});
```

- [ ] **Step 3: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 4: Implémenter**

`packages/kernel/src/snapshot/snapshot.ts`:
```ts
import { KernelError } from "../errors.js";
import { Vfs, isLazy } from "../vfs.js";
import { sha256Hex } from "./hash.js";
import type { ManifestEntry, SnapshotManifest, SnapshotStore } from "./store.js";

const enc = new TextEncoder();

export async function snapshotVfs(
  vfs: Vfs,
  store: SnapshotStore,
  opts: { meta?: unknown } = {},
): Promise<{ snapshotId: string; manifest: SnapshotManifest }> {
  // Paths triés → ordre d'insertion déterministe → JSON déterministe → id stable.
  const paths = [...vfs.files()].map(([p]) => p).filter((p) => p !== "/").sort();
  const entries: Record<string, ManifestEntry> = {};
  for (const path of paths) {
    const entry = vfs.entry(path);
    if (entry.kind === "dir") {
      entries[path] = { kind: "dir", mtime: entry.mtime };
      continue;
    }
    if (isLazy(entry.content)) {
      // Jamais hydraté depuis le restore : le blob est déjà dans le store.
      entries[path] = { kind: "file", hash: entry.content.hash, size: entry.content.size, mtime: entry.mtime };
      continue;
    }
    const hash = await sha256Hex(entry.content);
    if (!(await store.hasBlob(hash))) await store.putBlob(hash, entry.content);
    entries[path] = { kind: "file", hash, size: entry.content.byteLength, mtime: entry.mtime };
  }
  const manifest: SnapshotManifest = { version: 1, entries, ...(opts.meta !== undefined ? { meta: opts.meta } : {}) };
  const snapshotId = await sha256Hex(enc.encode(JSON.stringify(manifest)));
  await store.putTree(snapshotId, manifest);
  return { snapshotId, manifest };
}

export async function restoreVfs(
  store: SnapshotStore,
  snapshotId: string,
  opts: { now?: () => number } = {},
): Promise<{ vfs: Vfs; meta?: unknown }> {
  const manifest = await store.getTree(snapshotId);
  if (!manifest) throw new KernelError("ENOENT", `snapshot ${snapshotId}`);
  const vfs = new Vfs(opts);
  vfs.hydrator = async (hash) => {
    const data = await store.getBlob(hash);
    if (!data) throw new KernelError("ENOENT", `blob ${hash}`);
    return data;
  };
  const paths = Object.keys(manifest.entries).sort(); // parents avant enfants
  for (const path of paths) {
    const e = manifest.entries[path]!;
    if (e.kind === "dir") vfs.mkdir(path, { recursive: true });
  }
  for (const path of paths) {
    const e = manifest.entries[path]!;
    if (e.kind === "file") vfs.putLazyFile(path, { hash: e.hash, size: e.size }, e.mtime);
  }
  return { vfs, meta: manifest.meta };
}
```

Note déterminisme : `meta` fait partie du manifest, donc deux snapshots au même contenu FS mais meta différent ont des ids différents — c'est voulu (le meta contient l'historique de conversation, qui fait partie de l'état de session). Le test "same FS → same id" n'utilise pas de meta.

- [ ] **Step 5: Vérifier le pass** — `pnpm -F @ork.ai/kernel test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/snapshot/snapshot.ts packages/kernel/src/vfs.ts packages/kernel/test/snapshot.test.ts
git commit -m "feat(kernel): content-addressed snapshot/restore with lazy hydration"
```

---

### Task 15: Assemblage — `createKernel` / `restoreKernel` + exports publics

**Files:**
- Create: `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/kernel.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { expect, test } from "vitest";
import { createKernel, restoreKernel } from "../src/kernel.js";
import { MemorySnapshotStore } from "../src/snapshot/store.js";
import { readText, writeAll } from "../src/streams.js";

const dec = new TextDecoder();

test("createKernel seeds files (string and bytes), creates parent dirs", async () => {
  const kernel = createKernel({
    files: { "/data/users.json": '[{"name":"Alice"}]', "/data/raw.bin": new Uint8Array([1, 2]) },
  });
  expect(dec.decode(await kernel.sys.readFile("/data/users.json"))).toBe('[{"name":"Alice"}]');
  expect((await kernel.sys.stat("/data/raw.bin")).size).toBe(2);
});

test("full pipeline: middlewares actifs (trace + permissions + quotas)", async () => {
  const kernel = createKernel({
    files: { "/ro/doc.md": "x" },
    mounts: [{ path: "/ro", mode: "ro" }],
    limits: { maxSyscallsPerTurn: 2 },
  });
  const events: unknown[] = [];
  kernel.events.subscribe((ev) => events.push(ev));
  await expect(kernel.sys.writeFile("/ro/y.txt", "y")).rejects.toMatchObject({ code: "EACCES" });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "syscall", name: "writeFile", ok: false, code: "EACCES" }),
  );
  await kernel.sys.readFile("/ro/doc.md");
  await kernel.sys.readFile("/ro/doc.md");
  await expect(kernel.sys.readFile("/ro/doc.md")).rejects.toMatchObject({ code: "EQUOTA" });
  kernel.resetTurn();
  await expect(kernel.sys.readFile("/ro/doc.md")).resolves.toBeInstanceOf(Uint8Array);
});

test("procs wired to the same event bus", async () => {
  const kernel = createKernel();
  const events: unknown[] = [];
  kernel.events.subscribe((ev) => events.push(ev));
  const proc = kernel.procs.spawn(["echo"], async (io) => {
    await writeAll(io.stdout, "hi");
    return 0;
  });
  expect(await readText(proc.stdout)).toBe("hi");
  await proc.exit;
  expect(events).toContainEqual(expect.objectContaining({ type: "proc.spawn", argv: ["echo"] }));
  expect(events).toContainEqual(expect.objectContaining({ type: "proc.exit", exitCode: 0 }));
});

test("snapshot → restoreKernel round-trip, work continues", async () => {
  const store = new MemorySnapshotStore();
  const k1 = createKernel({ files: { "/work/a.txt": "v1" } });
  await k1.sys.writeFile("/work/b.txt", "added");
  const { snapshotId } = await k1.snapshot(store, { meta: { turn: 1 } });

  const { kernel: k2, meta } = await restoreKernel({ store, snapshotId });
  expect(meta).toEqual({ turn: 1 });
  expect(dec.decode(await k2.sys.readFile("/work/b.txt"))).toBe("added");
  await k2.sys.writeFile("/work/c.txt", "more");
  const { snapshotId: id2 } = await k2.snapshot(store);
  expect(id2).not.toBe(snapshotId);
});

test("network blocked by default on a fresh kernel", async () => {
  const kernel = createKernel();
  await expect(kernel.sys.fetch("https://example.com")).rejects.toMatchObject({ code: "ENETBLOCKED" });
});
```

- [ ] **Step 2: Vérifier l'échec** — `pnpm -F @ork.ai/kernel test` → FAIL.

- [ ] **Step 3: Implémenter**

`packages/kernel/src/kernel.ts`:
```ts
import { EventBus } from "./events.js";
import { normalizePath, parentOf } from "./path.js";
import { ProcTable } from "./proc.js";
import { createSyscalls, type FsSyscalls } from "./syscalls.js";
import { Vfs } from "./vfs.js";
import { permissionsMiddleware, type PermissionsConfig } from "./middleware/permissions.js";
import { DEFAULT_LIMITS, QuotaTracker, quotasMiddleware, type Limits } from "./middleware/quotas.js";
import { traceMiddleware } from "./middleware/trace.js";
import { restoreVfs, snapshotVfs } from "./snapshot/snapshot.js";
import type { SnapshotStore } from "./snapshot/store.js";

export interface KernelOptions {
  /** Fichiers initiaux. Les dossiers parents sont créés automatiquement. */
  files?: Record<string, string | Uint8Array>;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Kernel {
  sys: FsSyscalls;
  procs: ProcTable;
  events: EventBus;
  vfs: Vfs;
  limits: Limits;
  snapshot(store: SnapshotStore, opts?: { meta?: unknown }): Promise<{ snapshotId: string }>;
  /** À appeler en début de tour agent : remet les compteurs de quota par tour à zéro. */
  resetTurn(): void;
}

function buildKernel(vfs: Vfs, opts: KernelOptions): Kernel {
  const bus = new EventBus();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const tracker = new QuotaTracker(limits, vfs);
  const sys = createSyscalls({
    vfs,
    fetchImpl: opts.fetchImpl,
    middlewares: [
      traceMiddleware(bus), // outermost : trace aussi les refus
      permissionsMiddleware({ mounts: opts.mounts, network: opts.network }),
      quotasMiddleware(tracker),
    ],
  });
  const procs = new ProcTable({ bus, maxProcs: limits.maxProcs });
  return {
    sys,
    procs,
    events: bus,
    vfs,
    limits,
    snapshot: async (store, o) => {
      const { snapshotId } = await snapshotVfs(vfs, store, o);
      return { snapshotId };
    },
    resetTurn: () => tracker.resetTurn(),
  };
}

export function createKernel(opts: KernelOptions = {}): Kernel {
  const vfs = new Vfs({ now: opts.now });
  if (opts.files) {
    const enc = new TextEncoder();
    for (const [rawPath, content] of Object.entries(opts.files)) {
      const path = normalizePath(rawPath);
      const parent = parentOf(path);
      if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      vfs.writeFile(path, typeof content === "string" ? enc.encode(content) : content);
    }
  }
  return buildKernel(vfs, opts);
}

export async function restoreKernel(
  args: { store: SnapshotStore; snapshotId: string } & KernelOptions,
): Promise<{ kernel: Kernel; meta?: unknown }> {
  const { vfs, meta } = await restoreVfs(args.store, args.snapshotId, { now: args.now });
  return { kernel: buildKernel(vfs, args), meta };
}
```

`packages/kernel/src/index.ts` (remplace le contenu) :
```ts
export const KERNEL_VERSION = "0.0.1";

export { KernelError, isKernelError, type ErrnoCode } from "./errors.js";
export { normalizePath, parentOf, basename } from "./path.js";
export { EventBus, type KernelEvent, type KernelEventListener } from "./events.js";
export { Vfs, isLazy, type Entry, type FileEntry, type DirEntry, type Stat, type LazyRef, type Hydrator } from "./vfs.js";
export {
  createSyscalls,
  type FsSyscalls,
  type Middleware,
  type SyscallDescriptor,
  type SyscallName,
} from "./syscalls.js";
export { permissionsMiddleware, type PermissionsConfig } from "./middleware/permissions.js";
export { quotasMiddleware, QuotaTracker, DEFAULT_LIMITS, type Limits } from "./middleware/quotas.js";
export { traceMiddleware } from "./middleware/trace.js";
export { ProcTable, type ProcHandle, type ProcIo, type ProcMain, type ProcInfo, type ProcStatus } from "./proc.js";
export { readAll, readText, writeAll } from "./streams.js";
export { sha256Hex } from "./snapshot/hash.js";
export { MemorySnapshotStore, type SnapshotStore, type SnapshotManifest, type ManifestEntry } from "./snapshot/store.js";
export { DiskSnapshotStore } from "./snapshot/disk-store.js";
export { snapshotVfs, restoreVfs } from "./snapshot/snapshot.js";
export { createKernel, restoreKernel, type Kernel, type KernelOptions } from "./kernel.js";
```

- [ ] **Step 4: Vérifier le pass complet** —

```bash
pnpm -F @ork.ai/kernel test
pnpm -F @ork.ai/kernel typecheck
```
Expected: tous les tests PASS (smoke + 13 fichiers de tests), typecheck propre. Mettre à jour `smoke.test.ts` si l'import de `KERNEL_VERSION` a changé (il ne devrait pas).

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/kernel.ts packages/kernel/src/index.ts packages/kernel/test/kernel.test.ts
git commit -m "feat(kernel): createKernel/restoreKernel wiring + public API"
```

---

### Task 16: Vérification finale du chantier

- [ ] **Step 1: Suite complète + typecheck depuis la racine**

```bash
pnpm test && pnpm typecheck
```
Expected: tout vert.

- [ ] **Step 2: Revue rapide du diff de la branche**

```bash
git log --oneline main..HEAD
git diff main --stat
```
Vérifier : pas de fichier oublié, pas de `console.log` de debug, exports d'`index.ts` complets.

- [ ] **Step 3: Commit final éventuel (nettoyage) puis fin**

La branche `feat/kernel` reste locale (pas de push sans demande explicite). Le chantier suivant (`@ork.ai/shell`) fera l'objet de son propre plan.

---

## Couverture spec → tâches

| Exigence spec (§3 kernel) | Tâche(s) |
|---|---|
| VFS in-memory, inodes Map, pas de symlinks | 5, 6 |
| Mounts ro/rw | 8 |
| Snapshot content-addressed (blobs SHA-256, manifest, incrémental, dédup) | 13, 14 |
| Restore lazy (tree immédiat, blobs au premier read) | 14 |
| Fork de session = copier un hash | 14 (ids déterministes ; restore N fois le même id) |
| Process virtuels (proc table, pid/ppid, Web Streams, spawn/pipe, `&`) | 11, 12 |
| Syscalls (~12 → 11, fusion open/read/write) | 7 |
| Middleware permissions (ro mounts, network allow-list, off par défaut) | 8 |
| Middleware quotas (maxFsBytes, maxFileSize, maxSyscallsPerTurn, maxProcs) | 9, 12 |
| Middleware trace + event bus typé | 4, 10 |
| Erreurs typées ENOENT/EACCES/EQUOTA/ENETBLOCKED… | 2 (et partout) |
| Stores : mémoire + disque (adapters blob cloud → chantier @ork.ai/server) | 13 |
| `ETIMEOUT` (timeout par proc) | **Reporté au chantier shell/harness** : le timeout s'applique à l'exécution d'une commande, il sera posé par l'appelant via `AbortSignal` autour de `proc.exit`. Le code errno existe déjà (Task 2). |
| Metadata de session dans le snapshot (`meta`) | 14, 15 |
