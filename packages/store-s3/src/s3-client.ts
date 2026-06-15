import { AwsClient } from "aws4fetch";
import { KernelError } from "@ork.ai/kernel";

/**
 * Même regex que disk-store / disk-pointer-store : on refuse tout ce qui pourrait
 * échapper du préfixe ou casser le découpage des clés objet.
 */
export const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeKey(key: string, what = "store key"): void {
  if (!SAFE_KEY.test(key)) throw new KernelError("EINVAL", `unsafe ${what}: ${key}`);
}

/** Une fonction compatible `fetch` : c'est par là que passe (ou pas) la signature SigV4. */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface S3StoreConfig {
  bucket: string;
  /** Préfixe de clé optionnel (ex. "tenants/acme/"). Concaténé tel quel — finir par "/" si besoin. */
  prefix?: string;
  /** Endpoint du service S3-compatible, ex. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  /** Région SigV4. R2 ignore mais signe "auto" ; AWS exige la vraie région. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Injecté pour les tests : reçoit (url, init) comme `fetch`. Quand fourni, on NE
   * construit PAS de client signé — l'appelant contrôle entièrement le transport.
   * Par défaut : global fetch enveloppé par aws4fetch (AwsClient.fetch).
   */
  fetchImpl?: FetchImpl;
}

/**
 * Petit client HTTP sur l'API objet S3 : pas de SDK lourd, juste fetch + SigV4
 * (via aws4fetch quand on signe pour de vrai). Construit les URLs objet et
 * normalise la gestion d'erreur.
 */
export class S3HttpClient {
  readonly #fetch: FetchImpl;
  readonly #base: string; // endpoint + "/" + bucket, sans slash final
  readonly prefix: string;

  constructor(config: S3StoreConfig) {
    this.prefix = config.prefix ?? "";
    const endpoint = config.endpoint.replace(/\/+$/, "");
    this.#base = `${endpoint}/${config.bucket}`;
    if (config.fetchImpl) {
      // Mode test (ou transport custom) : on bypasse complètement la signature.
      this.#fetch = config.fetchImpl;
    } else {
      const client = new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: "s3",
        region: config.region ?? "auto",
      });
      this.#fetch = (url, init) => client.fetch(url, init);
    }
  }

  url(key: string): string {
    // key est déjà sûr (assertSafeKey amont) ; on encode pour les segments fixes (blobs/, etc.).
    return `${this.#base}/${this.prefix}${key}`;
  }

  fetch(key: string, init?: RequestInit): Promise<Response> {
    return this.#fetch(this.url(key), init);
  }

  /**
   * ListObjectsV2 brut sur le bucket. `subPrefix` est concaténé au préfixe du
   * store (ex. "blobs/"). `continuationToken` pagine au-delà de 1000 clés.
   */
  listObjects(subPrefix: string, continuationToken?: string): Promise<Response> {
    const params = new URLSearchParams({ "list-type": "2", prefix: `${this.prefix}${subPrefix}` });
    if (continuationToken) params.set("continuation-token", continuationToken);
    return this.#fetch(`${this.#base}?${params.toString()}`, { method: "GET" });
  }
}

/**
 * Parse les `<Key>` d'une réponse ListObjectsV2 par regex (les réponses S3 sont
 * du XML bien formé ; on évite une dépendance XML lourde). Renvoie aussi le
 * `NextContinuationToken` pour la pagination. Acceptable pour du S3 conforme —
 * documenté comme tel. Les entités XML usuelles (&amp; &lt; &gt;) sont décodées.
 */
export function parseListObjectsV2(xml: string): { keys: string[]; nextToken: string | null } {
  const keys: string[] = [];
  const keyRe = /<Key>([\s\S]*?)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(xml)) !== null) keys.push(decodeXmlEntities(m[1]!));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const nextToken = truncated && tokenMatch ? decodeXmlEntities(tokenMatch[1]!) : null;
  return { keys, nextToken };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Lit un extrait du corps (pour les messages d'erreur), tolérant aux échecs. */
async function bodyExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 512 ? `${text.slice(0, 512)}…` : text;
  } catch {
    return "<no body>";
  }
}

/** Lève une KernelError EIO-style sur une réponse non gérée (statut inattendu). */
export async function throwOnUnexpected(res: Response, op: string): Promise<never> {
  const excerpt = await bodyExcerpt(res);
  // 501 / NotImplemented = backend sans support des écritures conditionnelles, etc.
  throw new KernelError("EINVAL", `s3 ${op}: HTTP ${res.status} ${res.statusText} — ${excerpt}`);
}
