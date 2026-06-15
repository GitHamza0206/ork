import { describe, expect, test } from "vitest";
import { gcSnapshots, isListable, snapshotVfs, Vfs } from "@ork.ai/kernel";
import { S3SnapshotStore } from "../src/snapshot-store.js";
import type { S3StoreConfig } from "../src/s3-client.js";
import { FakeS3, type FakeS3Options } from "./fake-s3.js";

const enc = new TextEncoder();

async function collect(it: AsyncIterable<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const x of it) out.add(x);
  return out;
}

function makeStore(opts?: FakeS3Options): { store: S3SnapshotStore; fake: FakeS3 } {
  const fake = new FakeS3(opts);
  const config: S3StoreConfig = {
    bucket: "ork",
    prefix: "ws/",
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    fetchImpl: fake.fetch,
  };
  return { store: new S3SnapshotStore(config), fake };
}

describe("S3SnapshotStore", () => {
  test("blob put/get/has round-trip", async () => {
    const { store } = makeStore();
    const hash = "abc123";
    expect(await store.hasBlob(hash)).toBe(false);
    expect(await store.getBlob(hash)).toBeNull();

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await store.putBlob(hash, data);

    expect(await store.hasBlob(hash)).toBe(true);
    const got = await store.getBlob(hash);
    expect(got).toEqual(data);
  });

  test("tree round-trip", async () => {
    const { store } = makeStore();
    const id = "snap1";
    expect(await store.getTree(id)).toBeNull();

    const manifest = {
      version: 1 as const,
      entries: { "/a.txt": { kind: "file" as const, hash: "h", size: 3, mtime: 1 } },
      meta: { foo: "bar" },
    };
    await store.putTree(id, manifest);
    expect(await store.getTree(id)).toEqual(manifest);
  });

  test("blobs are stored under prefix + blobs/, trees under trees/", async () => {
    const { store, fake } = makeStore();
    await store.putBlob("h1", new Uint8Array([9]));
    await store.putTree("t1", { version: 1, entries: {} });
    expect([...fake.objects.keys()]).toEqual(expect.arrayContaining(["ork/ws/blobs/h1", "ork/ws/trees/t1.json"]));
  });

  test("404 → null / false", async () => {
    const { store } = makeStore();
    expect(await store.getBlob("missing")).toBeNull();
    expect(await store.hasBlob("missing")).toBe(false);
    expect(await store.getTree("missing")).toBeNull();
  });

  test("unsafe keys rejected with EINVAL", async () => {
    const { store } = makeStore();
    await expect(store.getBlob("../evil")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.hasBlob("a/b")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.putBlob("a b", new Uint8Array())).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.getTree("..")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.putTree("a.b", { version: 1, entries: {} })).rejects.toMatchObject({ code: "EINVAL" });
  });

  test("non-404 error → throws with status", async () => {
    const fake = new FakeS3();
    // Force un 500 sur GET.
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return new Response("boom", { status: 500 });
      return fake.fetch(url, init);
    };
    const store = new S3SnapshotStore({
      bucket: "ork",
      endpoint: "https://e",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl,
    });
    await expect(store.getBlob("h1")).rejects.toMatchObject({ code: "EINVAL", message: expect.stringContaining("500") });
  });

  test("is listable", () => {
    const { store } = makeStore();
    expect(isListable(store)).toBe(true);
  });

  test("listTrees / listBlobs (with pagination) + delete (404 tolerated)", async () => {
    const { store, fake } = makeStore({ listPageSize: 1 }); // force la pagination
    await store.putBlob("h1", new Uint8Array([1]));
    await store.putBlob("h2", new Uint8Array([2]));
    await store.putTree("t1", { version: 1, entries: {} });
    await store.putTree("t2", { version: 1, entries: {} });

    expect(await collect(store.listTrees())).toEqual(new Set(["t1", "t2"]));
    expect(await collect(store.listBlobs())).toEqual(new Set(["h1", "h2"]));

    await store.deleteTree("t1");
    await store.deleteBlob("h2");
    await store.deleteTree("t1"); // re-delete → toléré (204)
    await store.deleteBlob("nope"); // absent → toléré

    expect(await collect(store.listTrees())).toEqual(new Set(["t2"]));
    expect(await collect(store.listBlobs())).toEqual(new Set(["h1"]));
    expect(fake.deleteCount).toBeGreaterThanOrEqual(4);
  });

  test("gcSnapshots end-to-end over fake S3", async () => {
    const { store } = makeStore({ listPageSize: 2 });

    const live = new Vfs({ now: () => 1 });
    live.writeFile("/keep.txt", enc.encode("keep"));
    live.writeFile("/live.txt", enc.encode("live"));
    const { snapshotId: liveId } = await snapshotVfs(live, store);

    const dead = new Vfs({ now: () => 1 });
    dead.writeFile("/keep.txt", enc.encode("keep")); // blob partagé
    dead.writeFile("/dead.txt", enc.encode("dead")); // blob unique au mort
    const { snapshotId: deadId } = await snapshotVfs(dead, store);

    const res = await gcSnapshots(store, { roots: [liveId] });
    expect(res).toMatchObject({ keptTrees: 1, deletedTrees: 1 });

    expect(await collect(store.listTrees())).toEqual(new Set([liveId]));
    expect(await store.getTree(deadId)).toBeNull();
    // L'arbre vivant reste restaurable : son blob unique survit.
    expect(await store.getTree(liveId)).not.toBeNull();
  });
});
