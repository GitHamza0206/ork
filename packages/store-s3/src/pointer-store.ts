import { KernelError, type PointerStore, type WorkspacePointer } from "@ork.ai/kernel";
import { assertSafeKey, S3HttpClient, throwOnUnexpected, type S3StoreConfig } from "./s3-client.js";

/**
 * PointerStore multi-instance via écritures conditionnelles S3 (If-None-Match / If-Match).
 * C'est LA pièce de correction concurrente : deux instances qui committent en
 * parallèle ne peuvent pas écraser le pointeur l'une de l'autre.
 *
 * Layout : `${prefix}pointers/${id}.json`.
 *
 * IMPORTANT : un backend SANS support des PUT conditionnels (réponse 501
 * NotImplemented) n'est PAS sûr en multi-instance — on lève une erreur explicite
 * pour que l'opérateur le sache au lieu de corrompre silencieusement les pointeurs.
 * R2 et les versions récentes d'AWS S3 supportent If-Match/If-None-Match sur PUT.
 */
export class S3PointerStore implements PointerStore {
  readonly #client: S3HttpClient;

  constructor(config: S3StoreConfig) {
    this.#client = new S3HttpClient(config);
  }

  #key(id: string): string {
    assertSafeKey(id, "workspace id");
    return `pointers/${id}.json`;
  }

  /** GET le pointeur courant + son ETag (pour le CAS If-Match). */
  async #getWithEtag(id: string): Promise<{ pointer: WorkspacePointer; etag: string } | null> {
    const res = await this.#client.fetch(this.#key(id), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) await throwOnUnexpected(res, `get ${id}`);
    const etag = res.headers.get("etag");
    const pointer = JSON.parse(await res.text()) as WorkspacePointer;
    if (!etag) {
      throw new KernelError("EINVAL", `s3 pointer ${id}: backend returned no ETag (CAS impossible)`);
    }
    return { pointer, etag };
  }

  async get(id: string): Promise<WorkspacePointer | null> {
    const found = await this.#getWithEtag(id);
    return found ? found.pointer : null;
  }

  async set(id: string, pointer: WorkspacePointer, expectedVersion: number): Promise<boolean> {
    const key = this.#key(id);
    const body = JSON.stringify(pointer);
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (expectedVersion === 0) {
      // Création : doit ne pas exister. If-None-Match: * → 412/409 si déjà là.
      headers["if-none-match"] = "*";
    } else {
      // Avance : on lit l'état courant pour vérifier la version ET capturer l'ETag.
      const current = await this.#getWithEtag(id);
      if (!current) return false; // attendu une version > 0 mais rien n'existe
      if (current.pointer.version !== expectedVersion) return false; // un autre a déjà avancé
      headers["if-match"] = current.etag;
    }

    const res = await this.#client.fetch(key, { method: "PUT", headers, body });
    if (res.ok) return true;
    // 412 PreconditionFailed / 409 Conflict = un écrivain concurrent a gagné la course.
    if (res.status === 412 || res.status === 409) return false;
    if (res.status === 501) {
      throw new KernelError(
        "EINVAL",
        `s3 pointer ${id}: backend does not support conditional PUT (HTTP 501) — ` +
          `NOT safe for multi-instance pointers. Use a backend with If-Match/If-None-Match support (R2, recent AWS S3).`,
      );
    }
    return throwOnUnexpected(res, `set ${id}`);
  }
}
