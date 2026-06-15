import { describe, expect, test } from "vitest";
import {
  Vfs,
  snapshotVfs,
  restoreVfs,
  Workspace,
  WorkspaceConflictError,
} from "@ork.ai/kernel";
import { S3SnapshotStore } from "../src/snapshot-store.js";
import { S3PointerStore } from "../src/pointer-store.js";
import type { S3StoreConfig } from "../src/s3-client.js";
import { FakeS3 } from "./fake-s3.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function stores() {
  const fake = new FakeS3();
  const config: S3StoreConfig = {
    bucket: "ork",
    prefix: "t/",
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    fetchImpl: fake.fetch,
  };
  return {
    store: new S3SnapshotStore(config),
    pointers: new S3PointerStore(config),
    fake,
  };
}

describe("integration over fake S3", () => {
  test("snapshotVfs → S3SnapshotStore → restoreVfs round-trip", async () => {
    const { store } = stores();
    const vfs = new Vfs();
    vfs.mkdir("/workspace", { recursive: true });
    vfs.writeFile("/workspace/a.txt", enc.encode("hello"));
    vfs.writeFile("/workspace/b.bin", new Uint8Array([0, 1, 2, 255]));

    const { snapshotId } = await snapshotVfs(vfs, store, { meta: { tag: "v1" } });
    expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);

    const { vfs: restored, meta } = await restoreVfs(store, snapshotId);
    expect(meta).toEqual({ tag: "v1" });
    expect(dec.decode(await restored.readFile("/workspace/a.txt"))).toBe("hello");
    expect(await restored.readFile("/workspace/b.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));

    // re-snapshot d'un vfs restauré → même id (content-addressed)
    const again = await snapshotVfs(restored, store, { meta: { tag: "v1" } });
    expect(again.snapshotId).toBe(snapshotId);
  });

  test("Workspace open/commit over S3 stores; reopen sees committed state", async () => {
    const s = stores();
    const ws1 = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers });
    await ws1.kernel.sys.mkdir("/workspace", { recursive: true });
    await ws1.kernel.sys.writeFile("/workspace/a.txt", "v1");
    const { snapshotId } = await ws1.commit();
    expect(await s.pointers.get("u1")).toEqual({ snapshotId, version: 1 });

    const ws2 = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers });
    expect(dec.decode(await ws2.kernel.sys.readFile("/workspace/a.txt"))).toBe("v1");
  });

  test("concurrent commit conflict → WorkspaceConflictError, winner persisted", async () => {
    const s = stores();
    const seed = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers, seed: { "/base.txt": "b" } });
    await seed.commit();

    const a = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers });
    const b = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers });
    await a.kernel.sys.writeFile("/from-a.txt", "a");
    await b.kernel.sys.writeFile("/from-b.txt", "b");
    await a.commit(); // gagne le CAS If-Match
    await expect(b.commit()).rejects.toBeInstanceOf(WorkspaceConflictError);

    const ws = await Workspace.open({ id: "u1", store: s.store, pointers: s.pointers });
    expect(ws.kernel.vfs.exists("/from-a.txt")).toBe(true);
    expect(ws.kernel.vfs.exists("/from-b.txt")).toBe(false);
  });
});
