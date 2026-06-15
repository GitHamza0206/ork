import { describe, expect, test } from "vitest";
import { S3SnapshotStore } from "../src/snapshot-store.js";
import { S3PointerStore } from "../src/pointer-store.js";
import type { S3StoreConfig } from "../src/s3-client.js";

/**
 * Test live MANUEL contre un vrai bucket (R2 / S3 / MinIO). SKIPPÉ par défaut.
 *
 * Pour le lancer, exporter les variables puis retirer le `.skip` (ou lancer
 * uniquement ce fichier) :
 *
 *   R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   R2_BUCKET=ork-test \
 *   R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... \
 *   R2_REGION=auto \
 *   pnpm --filter @ork.ai/store-s3 vitest run test/live-r2.test.ts
 *
 * Sans fetchImpl, l'adaptateur signe les requêtes via aws4fetch (SigV4) et tape
 * le vrai endpoint. Utiliser un bucket jetable : le test écrit blobs/ trees/
 * pointers/ sous un préfixe horodaté.
 */
const live = process.env.R2_ENDPOINT && process.env.R2_BUCKET ? describe : describe.skip;

live("live R2/S3 (manual)", () => {
  function config(): S3StoreConfig {
    return {
      bucket: process.env.R2_BUCKET!,
      prefix: `ork-livetest-${Date.now()}/`,
      endpoint: process.env.R2_ENDPOINT!,
      region: process.env.R2_REGION ?? "auto",
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    };
  }

  test("blob round-trip", async () => {
    const store = new S3SnapshotStore(config());
    const data = new Uint8Array([1, 2, 3]);
    await store.putBlob("livehash", data);
    expect(await store.hasBlob("livehash")).toBe(true);
    expect(await store.getBlob("livehash")).toEqual(data);
  });

  test("pointer CAS", async () => {
    const pointers = new S3PointerStore(config());
    expect(await pointers.set("lw", { snapshotId: "s1", version: 1 }, 0)).toBe(true);
    expect(await pointers.set("lw", { snapshotId: "s2", version: 1 }, 0)).toBe(false);
    expect(await pointers.set("lw", { snapshotId: "s2", version: 2 }, 1)).toBe(true);
    expect(await pointers.get("lw")).toEqual({ snapshotId: "s2", version: 2 });
  });
});
