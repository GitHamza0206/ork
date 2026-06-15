import { describe, expect, test } from "vitest";
import type { PointerStore } from "@ork.ai/kernel";
import { S3PointerStore } from "../src/pointer-store.js";
import type { S3StoreConfig } from "../src/s3-client.js";
import { FakeS3, type FakeS3Options } from "./fake-s3.js";

function makeStore(opts?: FakeS3Options): { store: S3PointerStore; fake: FakeS3 } {
  const fake = new FakeS3(opts);
  const config: S3StoreConfig = {
    bucket: "ork",
    prefix: "ws/",
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    fetchImpl: fake.fetch,
  };
  return { store: new S3PointerStore(config), fake };
}

// --- suite comportementale partagée (portée depuis kernel/test/pointer-store.test.ts) ---
function behavioralSuite(make: () => { store: PointerStore }) {
  test("get on unknown id → null", async () => {
    const { store } = make();
    expect(await store.get("u1")).toBeNull();
  });

  test("first set requires expectedVersion 0", async () => {
    const { store } = make();
    expect(await store.set("u1", { snapshotId: "a", version: 1 }, 0)).toBe(true);
    expect(await store.get("u1")).toEqual({ snapshotId: "a", version: 1 });
    // re-création avec expectedVersion 0 alors que v1 existe → refus
    expect(await store.set("u1", { snapshotId: "b", version: 1 }, 0)).toBe(false);
  });

  test("CAS advances only from the expected version", async () => {
    const { store } = make();
    await store.set("u1", { snapshotId: "a", version: 1 }, 0);
    expect(await store.set("u1", { snapshotId: "b", version: 2 }, 1)).toBe(true);
    // un écrivain retardataire qui croit encore être en v1 → refus
    expect(await store.set("u1", { snapshotId: "c", version: 2 }, 1)).toBe(false);
    expect(await store.get("u1")).toEqual({ snapshotId: "b", version: 2 });
  });

  test("ids are isolated", async () => {
    const { store } = make();
    await store.set("u1", { snapshotId: "a", version: 1 }, 0);
    expect(await store.get("u2")).toBeNull();
  });

  test("concurrent CAS — exactly one winner", async () => {
    const { store } = make();
    await store.set("u1", { snapshotId: "base", version: 1 }, 0);
    const results = await Promise.all([
      store.set("u1", { snapshotId: "x", version: 2 }, 1),
      store.set("u1", { snapshotId: "y", version: 2 }, 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const final = await store.get("u1");
    expect(final?.version).toBe(2);
    expect(["x", "y"]).toContain(final?.snapshotId);
  });

  test("concurrent first-create (expectedVersion 0) — exactly one winner", async () => {
    const { store } = make();
    const results = await Promise.all([
      store.set("u1", { snapshotId: "x", version: 1 }, 0),
      store.set("u1", { snapshotId: "y", version: 1 }, 0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
}

describe("S3PointerStore — behavioral suite", () => {
  behavioralSuite(() => makeStore());
});

describe("S3PointerStore — S3 specifics", () => {
  test("unsafe id rejected with EINVAL", async () => {
    const { store } = makeStore();
    await expect(store.get("../evil")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(store.set("a/b", { snapshotId: "x", version: 1 }, 0)).rejects.toMatchObject({ code: "EINVAL" });
  });

  test("pointer persists across store instances (shared backend)", async () => {
    const fake = new FakeS3();
    const base: S3StoreConfig = {
      bucket: "ork",
      endpoint: "https://e",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl: fake.fetch,
    };
    const a = new S3PointerStore(base);
    await a.set("u1", { snapshotId: "s1", version: 1 }, 0);
    const b = new S3PointerStore(base);
    expect(await b.get("u1")).toEqual({ snapshotId: "s1", version: 1 });
  });

  test("backend without conditional PUT → clear error (not silent corruption)", async () => {
    const { store } = makeStore({ noConditional: true });
    await expect(store.set("u1", { snapshotId: "a", version: 1 }, 0)).rejects.toMatchObject({
      code: "EINVAL",
      message: expect.stringContaining("multi-instance"),
    });
  });

  test("backend without ETag → clear error", async () => {
    const { store } = makeStore({ noEtag: true });
    await store.set("u1", { snapshotId: "a", version: 1 }, 0); // création OK (If-None-Match)
    // get doit échouer faute d'ETag (CAS impossible)
    await expect(store.get("u1")).rejects.toMatchObject({ code: "EINVAL" });
  });
});
