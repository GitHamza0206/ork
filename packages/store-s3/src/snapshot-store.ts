import type { ListableSnapshotStore, SnapshotManifest } from "@ork.ai/kernel";
import {
  assertSafeKey,
  parseListObjectsV2,
  S3HttpClient,
  throwOnUnexpected,
  type S3StoreConfig,
} from "./s3-client.js";

/**
 * SnapshotStore sur API objet S3-compatible (AWS S3 / Cloudflare R2 / MinIO).
 * Layout : `${prefix}blobs/${hash}` (binaire immuable) et `${prefix}trees/${id}.json`.
 */
export class S3SnapshotStore implements ListableSnapshotStore {
  readonly #client: S3HttpClient;

  constructor(config: S3StoreConfig) {
    this.#client = new S3HttpClient(config);
  }

  #blobKey(hash: string): string {
    assertSafeKey(hash, "blob hash");
    return `blobs/${hash}`;
  }
  #treeKey(id: string): string {
    assertSafeKey(id, "tree id");
    return `trees/${id}.json`;
  }

  async putBlob(hash: string, data: Uint8Array): Promise<void> {
    const key = this.#blobKey(hash);
    // Les blobs sont content-addressed donc immuables. On pourrait poser
    // `If-None-Match: *` pour éviter une ré-écriture inutile, mais certains
    // backends répondent 501 NotImplemented sur PUT conditionnel : on garde le
    // PUT simple (idempotent : ré-écrire le même contenu est sans effet).
    const res = await this.#client.fetch(key, {
      method: "PUT",
      body: toArrayBuffer(data),
    });
    if (!res.ok) await throwOnUnexpected(res, `putBlob ${hash}`);
  }

  async getBlob(hash: string): Promise<Uint8Array | null> {
    const key = this.#blobKey(hash);
    const res = await this.#client.fetch(key, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) await throwOnUnexpected(res, `getBlob ${hash}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async hasBlob(hash: string): Promise<boolean> {
    const key = this.#blobKey(hash);
    const res = await this.#client.fetch(key, { method: "HEAD" });
    if (res.status === 404) return false;
    if (!res.ok) await throwOnUnexpected(res, `hasBlob ${hash}`);
    return true;
  }

  async putTree(id: string, manifest: SnapshotManifest): Promise<void> {
    const key = this.#treeKey(id);
    const res = await this.#client.fetch(key, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (!res.ok) await throwOnUnexpected(res, `putTree ${id}`);
  }

  async getTree(id: string): Promise<SnapshotManifest | null> {
    const key = this.#treeKey(id);
    const res = await this.#client.fetch(key, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) await throwOnUnexpected(res, `getTree ${id}`);
    return JSON.parse(await res.text()) as SnapshotManifest;
  }

  /** Itère les clés sous `${prefix}${subPrefix}` via ListObjectsV2 paginé. */
  async *#listKeys(subPrefix: string): AsyncIterable<string> {
    const fullPrefix = `${this.#client.prefix}${subPrefix}`;
    let token: string | undefined;
    do {
      const res = await this.#client.listObjects(subPrefix, token);
      if (!res.ok) await throwOnUnexpected(res, `list ${subPrefix}`);
      const { keys, nextToken } = parseListObjectsV2(await res.text());
      for (const key of keys) {
        // Les clés sont absolues (préfixe inclus) : on retire `${prefix}${subPrefix}`.
        if (key.startsWith(fullPrefix)) yield key.slice(fullPrefix.length);
      }
      token = nextToken ?? undefined;
    } while (token);
  }

  async *listTrees(): AsyncIterable<string> {
    for await (const name of this.#listKeys("trees/")) {
      if (name.endsWith(".json")) yield name.slice(0, -".json".length);
    }
  }

  async *listBlobs(): AsyncIterable<string> {
    yield* this.#listKeys("blobs/");
  }

  async deleteTree(id: string): Promise<void> {
    const res = await this.#client.fetch(this.#treeKey(id), { method: "DELETE" });
    // 404 toléré (déjà supprimé). S3 répond souvent 204 même si absent.
    if (res.status !== 404 && !res.ok) await throwOnUnexpected(res, `deleteTree ${id}`);
  }

  async deleteBlob(hash: string): Promise<void> {
    const res = await this.#client.fetch(this.#blobKey(hash), { method: "DELETE" });
    if (res.status !== 404 && !res.ok) await throwOnUnexpected(res, `deleteBlob ${hash}`);
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes.buffer;
}
