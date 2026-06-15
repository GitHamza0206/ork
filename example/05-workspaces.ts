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
