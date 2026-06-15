# ork — Runtime agentique in-memory-first

**Date** : 2026-06-10
**Statut** : Design validé
**Inspiration** : [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash) (interpréteur bash sandboxé en TS) — ork reprend l'idée du shell pur TypeScript sur FS virtuel, mais la repense autour d'un micro-kernel et y ajoute tout ce qui manque : process model async, snapshot/restore durable, tools façon Claude Code, harness LLM intégré, API serveur.

## 1. Vision

Un runtime agentique en TypeScript, in-memory-first : on POST un prompt + des fichiers (ou un snapshot existant), un agent type Claude Code travaille dans un filesystem virtuel avec un vrai shell, et on récupère un stream d'événements + un snapshot durable du FS.

- **Zéro VM, zéro disque** : démarrage en millisecondes, isolation par construction (le code n'a accès qu'au VFS et aux syscalls).
- **Use case cible** : agents embarqués dans un SaaS, sessions longues, état durable par tenant.
- **Compute stateless** : restore → tour en RAM → snapshot → éviction. N'importe quelle instance reprend n'importe quelle session.

### Ce que ork n'est pas

- Pas un bash complet : sous-ensemble agentique, spec dérivée d'un corpus de commandes réellement émises par des agents.
- Pas une VM : pas de binaires arbitraires. Pour ça, Vercel Sandbox / Firecracker.
- Pas un shell interactif : pas de TTY, pas de job control interactif.

## 2. Architecture — micro-kernel agentique

```
┌────────────────────────────────────────┐
│            SERVER API (HTTP/SSE)       │  @ork.ai/server
├────────────────────────────────────────┤
│         HARNESS (boucle LLM)           │  @ork.ai/harness
├────────────────────────────────────────┤
│             USERLAND                   │
│   shell (AST) · commandes · tools      │  @ork.ai/shell, @ork.ai/tools
├────────────────────────────────────────┤
│      SYSCALL BOUNDARY (~12 appels)     │
│  permissions · quotas · trace · events │
├────────────────────────────────────────┤
│  KERNEL : VFS · proc table · event bus │  @ork.ai/kernel
│        snapshot content-addressed      │
└────────────────────────────────────────┘
              ▼ snapshot/restore ▼
        Blob store (Vercel Blob/R2/S3)
```

Principe central : **tout passe par la frontière syscall**. Le shell, chaque commande builtin et chaque tool Claude Code sont du userland ; ils ne peuvent pas contourner les permissions, quotas ni la trace. C'est le contraire de just-bash, où chaque commande appelle directement le FS et où les policies sont éparpillées.

Monorepo pnpm, 5 packages construits dans cet ordre (chacun aura son propre plan d'implémentation) :

| Package | Rôle | Dépend de |
|---|---|---|
| `@ork.ai/kernel` | VFS, procs, syscalls, events, snapshot | — |
| `@ork.ai/shell` | lexer → AST → interpréteur + ~30 commandes | kernel |
| `@ork.ai/tools` | Bash/Read/Write/Edit/Glob/Grep (format AI SDK) | kernel, shell |
| `@ork.ai/harness` | boucle agent, contexte, compaction, API session | tools |
| `@ork.ai/server` | HTTP/SSE, sessions, snapshot stores | harness |

## 3. `@ork.ai/kernel`

### VFS

- Inodes en mémoire : `Map<path, Entry>` où `Entry = { kind: 'file', content: Uint8Array, mtime } | { kind: 'dir', mtime }`.
- Pas de symlinks en v1 (source n°1 d'attaques de path traversal et d'edge cases ; just-bash les bloque aussi).
- Mounts : un point de montage = un sous-arbre avec mode `rw` ou `ro` (ex. `/workspace` rw + `/knowledge` ro).

### Snapshot content-addressed (façon git)

- Blob = contenu hashé SHA-256. Tree = mapping paths → hashes. Snapshot = hash racine + métadonnées (dont l'historique de conversation sérialisé).
- **Incrémental** : seuls les blobs nouveaux sont uploadés. **Dédup** gratuite entre sessions/tenants partageant des fichiers de base. **Fork** de session = copier un hash racine.
- **Restore lazy** : on charge le tree immédiatement ; le contenu d'un blob est fetché au premier `read`. Reprise de session quasi instantanée même sur de gros FS.

### Process virtuels

- Un process = fonction async enregistrée dans la proc table : `{ pid, ppid, argv, stdin, stdout, stderr, exitCode, status }`. stdin/stdout/stderr en Web Streams (`ReadableStream`/`WritableStream`).
- `spawn()` crée un proc ; `pipe()` connecte stdout→stdin ; `cmd &` = spawn sans await. L'async est natif au kernel, pas bolté dans l'interpréteur.
- **Les tools du harness tournent aussi comme des procs** : un `Edit` et un `grep` laissent la même trace dans le même arbre de process.

### Syscalls (~12)

`open, read, write, stat, readdir, mkdir, rm, rename, spawn, wait, pipe, fetch`

Chaque appel traverse une chaîne de middlewares, dans l'ordre :
1. **Permissions** — mounts ro/rw, allow-list d'URL pour `fetch` (réseau off par défaut).
2. **Quotas** — `maxFsBytes`, `maxFileSize`, `maxProcs`, `maxSyscallsPerTurn`, timeout par proc. Dépassement → erreur typée `EQUOTA`.
3. **Trace** — chaque syscall émet un event typé sur l'event bus.

### Event bus

Events typés : `syscall`, `proc.spawn`, `proc.exit`, `fs.write`, `net.fetch`, … Alimente : le streaming temps réel vers le client, l'audit, le debug d'agents. Le journal d'un tour est borné en taille (quota).

### Erreurs

Erreurs typées à la frontière : `ENOENT`, `EISDIR`, `ENOTDIR`, `EACCES`, `EQUOTA`, `ETIMEOUT`, `ENETBLOCKED`. Le shell les mappe en exit codes + message stderr ; le harness en messages visibles par le modèle (l'agent peut se corriger).

## 4. `@ork.ai/shell`

### Sous-ensemble bash (spec par corpus)

La spec du sous-ensemble est un **corpus versionné de commandes réelles** émises par des agents (point de départ : patterns documentés par just-bash + nos sessions Claude Code ; enrichi en continu). Chaque entrée du corpus est un test golden comparé au vrai bash.

**Couvert en v1** : pipelines (`|`), redirections (`>`, `>>`, `2>&1`, `<`), `&&` `||` `;`, variables (`$VAR`, `${VAR}`, assignation), command substitution `$(...)`, quoting complet (simple, double, backslash), globs (`*`, `?`, `[...]`), heredocs, `if`/`for`/`while` simples, conditions `[ ]`/`test`, `cmd &`.

**Hors v1** (erreur de parse explicite et propre) : arrays, param expansion avancée (`${x%.*}`, `${x//a/b}`…), fonctions shell, arithmétique `$(( ))` au-delà des opérations de base, job control (`fg`/`bg`), extglob.

Pipeline : `Lexer → Parser (recursive descent) → AST → Interpreter async`. Limites de parse (taille d'entrée, profondeur de récursion) pour éviter les DoS. L'interpréteur exécute chaque commande comme un proc kernel ; un pipeline = N procs connectés par `pipe()`.

### Commandes builtin (~30, v1)

Fonctions TS pures sur syscalls, lazy-loaded :

`cat ls cd pwd echo printf grep head tail wc sort uniq cut tr sed find jq mkdir rm cp mv touch which env date base64 diff xargs tee true false test`

- `curl` passe par le syscall `fetch` → soumis à l'allow-list réseau.
- `awk` minimal en v1.1 (gros morceau ; `jq`+`grep`+`sed` couvrent l'essentiel des usages agents en attendant).
- Interface : `defineCommand({ name, exec(ctx) })` avec `ctx = { args, stdin, stdout, stderr, cwd, env, sys }` où `sys` est la table de syscalls. Commandes custom enregistrables par l'hôte.

## 5. `@ork.ai/tools`

Tools au format AI SDK, contrats identiques à Claude Code (les modèles les connaissent par cœur) :

- **Bash** — exécute une commande via le shell, retourne stdout/stderr/exitCode.
- **Read** — numéros de ligne (`cat -n`), `offset`/`limit`, erreur claire si absent/binaire.
- **Write** — création/écrasement.
- **Edit** — `old_string`/`new_string`, erreur si `old_string` non trouvé ou non unique, `replace_all`.
- **Glob** — patterns `**/*.ts`, tri par mtime.
- **Grep** — regex, filtres par glob, modes files/content/count.

Chaque tool tourne comme un proc kernel → même trace, mêmes quotas que le shell.

## 6. `@ork.ai/harness`

- **Boucle** : AI SDK v6, modèle en string `"provider/model"` via AI Gateway. Boucle sur `streamText` + tools avec stop conditions : max tours, budget tokens, timeout mur.
- **System prompt** : façon Claude Code, concis — décrit l'environnement (FS virtuel, mounts, tools, limites), personnalisable par l'hôte.
- **Contexte** : suivi du budget tokens ; au-delà d'un seuil, compaction (résumé des vieux tours par le modèle, conservation des N derniers messages bruts). Le FS, lui, ne se perd jamais : c'est le contexte durable.
- **API librairie** :

```ts
const session = await createSession({ files, model, system?, limits?, network? });
// ou
const session = await restoreSession({ snapshotId, store, model });

for await (const ev of session.send(prompt)) {
  // ev: text_delta | tool_call | tool_result | proc_event | error | turn_done
}
const { snapshotId } = await session.snapshot(store);
```

Tout est event-first : la même `AsyncIterable` alimente le SSE serveur, les logs, une UI.

## 7. `@ork.ai/server`

API HTTP sur **Hono** (portable Node / Vercel Fluid / Workers) :

| Route | Rôle |
|---|---|
| `POST /v1/sessions` | `{ files \| snapshotId, model, system? }` → `{ sessionId }` |
| `POST /v1/sessions/:id/messages` | `{ prompt }` → **SSE** des événements du tour |
| `GET /v1/sessions/:id/fs/*path` | lire un fichier résultat |
| `GET /v1/sessions/:id/fs?tree` | arbre du FS |
| `POST /v1/sessions/:id/snapshot` | snapshot explicite → `{ snapshotId }` |
| `DELETE /v1/sessions/:id` | éviction + snapshot final |

- **Cycle d'un tour** : restore (tree + blobs lazy) → tour agent en RAM → auto-snapshot fin de tour → éviction. Crash = on perd au pire le tour en cours.
- **`SnapshotStore`** : interface `{ putBlob, getBlob, putTree, getTree }` + adapters : mémoire (tests), disque, Vercel Blob, R2/S3.
- **Auth** : API key par tenant ; quotas kernel configurés par tenant.

## 8. Tests

1. **Corpus golden** : chaque construction du sous-ensemble bash testée contre le vrai bash (même approche que les comparison tests de just-bash).
2. **Property tests** VFS : invariants (write→read round-trip, rename atomique, quotas respectés).
3. **Round-trip snapshot** : snapshot → restore → FS identique (hash racine égal) ; restore lazy correct.
4. **Suite agent intégration** : scénarios complets (investigation de bug, analyse de config, génération de rapport) avec vrai modèle, comme la suite agent de just-bash.
5. **Sécurité** : path traversal, dépassement de quotas, réseau bloqué par défaut, prototype pollution (objets null-prototype / `Map` pour toute clé contrôlée par l'utilisateur).

## 9. Risques & décisions assumées

- **From scratch plutôt que fork de just-bash** : assumé pour avoir le process model async et la frontière syscall dès la ligne 1. Mitigation du coût : sous-ensemble bash strict piloté par corpus, et réutilisation des idées (pas du code) de just-bash.
- **Compat bash partielle** : un agent émettra parfois du bash hors sous-ensemble. Mitigation : erreurs de parse explicites renvoyées au modèle (il se corrige), corpus enrichi en continu depuis la prod.
- **Compaction de contexte** : la qualité du résumé conditionne les sessions longues. Mitigation : le FS persiste tout ; convention "notes de travail" dans le FS (`/workspace/NOTES.md`) encouragée par le system prompt.
- **Taille mémoire** : tout le FS en RAM. Mitigation : quotas `maxFsBytes` par session + hydratation lazy (on ne charge que ce qui est lu).

## 10. Ordre de construction

1. `@ork.ai/kernel` — VFS + syscalls + procs + events + snapshot (store mémoire/disque).
2. `@ork.ai/shell` — lexer/parser/interpréteur + 10 premières commandes, corpus golden en place.
3. `@ork.ai/tools` — les 6 tools sur le kernel.
4. `@ork.ai/harness` — boucle + API session + compaction.
5. `@ork.ai/server` — Hono + SSE + adapters blob + auth.

Chaque étape livre quelque chose de testable seul ; chaque package aura son propre plan d'implémentation détaillé.
