import { expect, test } from "vitest";
import {
  MemoryPointerStore,
  MemorySnapshotStore,
  Workspace,
} from "@ork.ai/kernel";
import { createSession } from "../src/session.js";
import { scriptedModel } from "./mock-model.js";

const dec = new TextDecoder();

function stores() {
  return { store: new MemorySnapshotStore(), pointers: new MemoryPointerStore() };
}

async function drain(events: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

test("two conversations share one user workspace", async () => {
  const s = stores();

  // — conversation A : écrit un fichier via le tool Bash —
  const wsA = await Workspace.open({ id: "u1", ...s, seed: { "/workspace/.keep": "" } });
  const convA = createSession({
    model: scriptedModel([
      { kind: "tools", calls: [{ toolName: "Bash", input: { command: "echo from-A > /workspace/notes.md" } }] },
      { kind: "text", text: "noted" },
    ]),
    workspace: wsA,
    messages: [],
  });
  await drain(convA.send("note quelque chose"));
  await wsA.commit();

  // — conversation B (HISTORIQUE INDÉPENDANT) : lit le fichier de A —
  const wsB = await Workspace.open({ id: "u1", ...s });
  const convB = createSession({
    model: scriptedModel([
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/workspace/notes.md" } }] },
      { kind: "text", text: "read it" },
    ]),
    workspace: wsB,
    messages: [],
  });
  const events = await drain(convB.send("lis les notes"));
  const toolResults = events.filter(
    (e): e is { type: string; output: string } => (e as { type: string }).type === "tool_result",
  );
  expect(toolResults.some((r) => r.output.includes("from-A"))).toBe(true);
  // les threads sont indépendants : B ne contient pas le tour de A
  expect(JSON.stringify(convB.messages)).not.toContain("note quelque chose");
});

test("messages seeds the thread; conversation grows on top of it", async () => {
  const prior = [
    { role: "user" as const, content: "tour précédent" },
    { role: "assistant" as const, content: "réponse précédente" },
  ];
  const session = createSession({
    model: scriptedModel([{ kind: "text", text: "suite" }]),
    files: {},
    messages: prior,
  });
  expect(session.messages).toHaveLength(2);
  await drain(session.send("nouveau tour"));
  expect(session.messages.length).toBeGreaterThan(2);
  expect(JSON.stringify(session.messages[0])).toContain("tour précédent");
});

test("workspace + files together → EINVAL", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  // createSession throw synchrone → toThrowError, pas .rejects
  expect(() =>
    createSession({ model: scriptedModel([{ kind: "text", text: "x" }]), workspace: ws, files: { "/a": "x" } }),
  ).toThrowError(/EINVAL/);
});

test("session FS effects land in the workspace kernel (commit persists them)", async () => {
  const s = stores();
  const ws = await Workspace.open({ id: "u1", ...s });
  const session = createSession({
    model: scriptedModel([
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/out.txt", content: "persisted" } }] },
      { kind: "text", text: "done" },
    ]),
    workspace: ws,
  });
  await drain(session.send("écris"));
  await ws.commit();
  const reopened = await Workspace.open({ id: "u1", ...s });
  expect(dec.decode(await reopened.kernel.sys.readFile("/out.txt"))).toBe("persisted");
});
