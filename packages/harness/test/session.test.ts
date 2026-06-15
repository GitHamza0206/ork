import { describe, expect, it } from "vitest";
import { MemorySnapshotStore } from "@ork.ai/kernel";
import { createSession, restoreSession, type SessionEvent } from "../src/index.js";
import { scriptedModel, throwingModel, errorPartModel } from "./mock-model.js";

const dec = new TextDecoder();

async function collect(it: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe("single-tool turn", () => {
  it("runs one Bash tool-call then finishes with text", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Bash", input: { command: "echo hello > /out.txt" } }] },
      { kind: "text", text: "done", finishReason: "stop" },
    ]);
    const session = createSession({ model });
    const events = await collect(session.send("write hello"));

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall && toolCall.type === "tool_call" && toolCall.tool).toBe("Bash");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult && toolResult.type === "tool_result" && toolResult.tool).toBe("Bash");

    const turnDone = events.find((e) => e.type === "turn_done");
    expect(turnDone).toBeDefined();
    expect(turnDone && turnDone.type === "turn_done" && turnDone.text).toBe("done");

    // The tool actually wrote to the kernel FS.
    expect(dec.decode(await session.readFile("/out.txt"))).toBe("hello\n");
  });

  it("emits a text_delta for streamed assistant text", async () => {
    const model = scriptedModel([{ kind: "text", text: "hi there", finishReason: "stop" }]);
    const session = createSession({ model });
    const events = await collect(session.send("hello"));
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join("")).toBe("hi there");
  });

  it("emits step_finish events for each model step", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Bash", input: { command: "echo a > /a.txt" } }] },
      { kind: "text", text: "ok", finishReason: "stop" },
    ]);
    const session = createSession({ model });
    const events = await collect(session.send("go"));
    const steps = events.filter((e) => e.type === "step_finish");
    expect(steps.length).toBe(2);
  });
});

describe("multi-step tool loop", () => {
  it("Write then Read across two tool calls; file persists", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/note.txt", content: "persisted" } }] },
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/note.txt" } }] },
      { kind: "text", text: "read it", finishReason: "stop" },
    ]);
    const session = createSession({ model });
    const events = await collect(session.send("write then read"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.length).toBe(2);
    // The Read result should contain the written content.
    const readResult = results[1];
    expect(readResult && readResult.type === "tool_result" && readResult.output).toContain("persisted");
    expect(dec.decode(await session.readFile("/note.txt"))).toBe("persisted");
  });

  it("respects maxSteps as the tool-loop cap", async () => {
    // Model always asks for another Bash call; maxSteps=2 caps it.
    const model = scriptedModel(
      Array.from({ length: 10 }, () => ({
        kind: "tools" as const,
        calls: [{ toolName: "Bash", input: { command: "echo x" } }],
      })),
    );
    const session = createSession({ model, maxSteps: 2 });
    const events = await collect(session.send("loop"));
    const steps = events.filter((e) => e.type === "step_finish");
    expect(steps.length).toBe(2);
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });
});

describe("multi-turn", () => {
  it("second turn sees first turn's FS changes and grows messages", async () => {
    const model = scriptedModel([
      // turn 1
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/state.txt", content: "v1" } }] },
      { kind: "text", text: "wrote", finishReason: "stop" },
      // turn 2
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/state.txt" } }] },
      { kind: "text", text: "saw v1", finishReason: "stop" },
    ]);
    const session = createSession({ model });

    await collect(session.send("write state"));
    const afterTurn1 = session.messages.length;
    expect(afterTurn1).toBeGreaterThan(0);

    const events2 = await collect(session.send("read state"));
    const readResult = events2.find((e) => e.type === "tool_result");
    expect(readResult && readResult.type === "tool_result" && readResult.output).toContain("v1");
    expect(session.messages.length).toBeGreaterThan(afterTurn1);
  });

  it("preserves conversation across turns when tokenBudget is set and turns are under budget", async () => {
    const model = scriptedModel([
      // turn 1
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/state.txt", content: "v1" } }] },
      { kind: "text", text: "wrote", finishReason: "stop" },
      // turn 2
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/state.txt" } }] },
      { kind: "text", text: "saw v1", finishReason: "stop" },
    ]);
    // Large budget => every turn is under budget (the normal case).
    const session = createSession({ model, tokenBudget: 1_000_000 });

    await collect(session.send("write state"));
    // Conversation must survive compaction, not be wiped to [].
    expect(session.messages.length).toBeGreaterThan(0);
    const afterTurn1 = session.messages.length;
    const firstPrompt = session.messages[0];
    expect(firstPrompt && firstPrompt.content).toBe("write state");

    const events2 = await collect(session.send("read state"));
    // Turn 2 still runs (messages were not emptied) and sees turn-1 context.
    const readResult = events2.find((e) => e.type === "tool_result");
    expect(readResult && readResult.type === "tool_result" && readResult.output).toContain("v1");
    expect(session.messages.length).toBeGreaterThan(afterTurn1);
    // Turn-1 user prompt still present.
    expect(session.messages[0] && session.messages[0].content).toBe("write state");
  });

  it("the user prompt is recorded in messages", async () => {
    const model = scriptedModel([{ kind: "text", text: "ok", finishReason: "stop" }]);
    const session = createSession({ model });
    await collect(session.send("my prompt"));
    const first = session.messages[0];
    expect(first && first.role).toBe("user");
    expect(first && first.content).toBe("my prompt");
  });
});

describe("error handling", () => {
  it("a throwing model yields an error event and completes the iterator", async () => {
    const model = throwingModel("provider exploded");
    const session = createSession({ model });
    const events = await collect(session.send("go")); // must not throw
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err && err.type === "error" && err.message).toContain("provider exploded");
  });

  it("an error stream part yields an error event without throwing", async () => {
    const model = errorPartModel("mid-stream fail");
    const session = createSession({ model });
    const events = await collect(session.send("go"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err && err.type === "error" && err.message).toContain("mid-stream fail");
  });

  it("a tool returning an error string is surfaced as a tool_result, loop continues", async () => {
    // Read a missing file -> @ork.ai/tools returns "Error: ..." string (not a throw).
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/missing.txt" } }] },
      { kind: "text", text: "recovered", finishReason: "stop" },
    ]);
    const session = createSession({ model });
    const events = await collect(session.send("read missing"));
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.output).toContain("does not exist");
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
  });
});

describe("abort-on-disconnect", () => {
  it("an already-aborted signal completes the iterator with an aborted error event (no throw)", async () => {
    const model = scriptedModel([{ kind: "text", text: "should not be seen", finishReason: "stop" }]);
    const session = createSession({ model });
    const ac = new AbortController();
    ac.abort();
    const events = await collect(session.send("go", { signal: ac.signal })); // must not throw
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err && err.type === "error" && err.message).toBe("aborted");
    // No turn_done on an aborted turn.
    expect(events.some((e) => e.type === "turn_done")).toBe(false);
    // The user prompt is still recorded.
    expect(session.messages[0] && session.messages[0].content).toBe("go");
  });

  it("aborting mid-stream completes cleanly with an aborted error event", async () => {
    // delayMs holds the model's doStream open; we abort while it's in flight.
    const model = scriptedModel([{ kind: "text", text: "late", finishReason: "stop" }], 50);
    const session = createSession({ model });
    const ac = new AbortController();
    const iter = session.send("go", { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const events = await collect(iter); // must not throw
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err && err.type === "error" && err.message).toBe("aborted");
    expect(events.some((e) => e.type === "turn_done")).toBe(false);
  });

  it("without a signal, behaviour is unchanged (backward compatible)", async () => {
    const model = scriptedModel([{ kind: "text", text: "hi", finishReason: "stop" }]);
    const session = createSession({ model });
    const events = await collect(session.send("go"));
    expect(events.some((e) => e.type === "turn_done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("files & seeding", () => {
  it("seeds initial files and listFiles returns written paths", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/dir/new.txt", content: "x" } }] },
      { kind: "text", text: "done", finishReason: "stop" },
    ]);
    const session = createSession({ model, files: { "/seed.txt": "seeded" } });
    await collect(session.send("write a file"));
    const files = await session.listFiles();
    expect(files).toContain("/seed.txt");
    expect(files).toContain("/dir/new.txt");
  });

  it("a tool can read a seeded file", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/config.json" } }] },
      { kind: "text", text: "read config", finishReason: "stop" },
    ]);
    const session = createSession({ model, files: { "/config.json": '{"k":1}' } });
    const events = await collect(session.send("read config"));
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.output).toContain('"k":1');
  });

  it("readFile reflects bash writes through the shell", async () => {
    const model = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Bash", input: { command: "mkdir -p /w && echo data > /w/f.txt" } }] },
      { kind: "text", text: "ok", finishReason: "stop" },
    ]);
    const session = createSession({ model });
    await collect(session.send("make dir"));
    expect(dec.decode(await session.readFile("/w/f.txt"))).toBe("data\n");
  });
});

describe("snapshot / restore", () => {
  it("snapshot then restoreSession preserves FS and conversation", async () => {
    const store = new MemorySnapshotStore();
    const model1 = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Write", input: { file_path: "/report.md", content: "# Report" } }] },
      { kind: "text", text: "wrote report", finishReason: "stop" },
    ]);
    const session = createSession({ model: model1 });
    await collect(session.send("write a report"));
    const messagesBefore = session.messages.length;
    const { snapshotId } = await session.snapshot(store);
    expect(snapshotId).toBeTruthy();

    // Restore with a fresh model that reads the prior file.
    const model2 = scriptedModel([
      { kind: "tools", calls: [{ toolName: "Read", input: { file_path: "/report.md" } }] },
      { kind: "text", text: "saw the report", finishReason: "stop" },
    ]);
    const restored = await restoreSession({ store, snapshotId, model: model2 });

    // FS restored.
    expect(dec.decode(await restored.readFile("/report.md"))).toBe("# Report");
    // Conversation restored.
    expect(restored.messages.length).toBe(messagesBefore);

    // A follow-up turn sees prior context (file present + grows messages).
    const events = await collect(restored.send("read the report"));
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.output).toContain("# Report");
    expect(restored.messages.length).toBeGreaterThan(messagesBefore);
  });

  it("snapshot meta merges user-supplied meta with messages", async () => {
    const store = new MemorySnapshotStore();
    const model = scriptedModel([{ kind: "text", text: "ok", finishReason: "stop" }]);
    const session = createSession({ model });
    await collect(session.send("hi"));
    const { snapshotId } = await session.snapshot(store, { meta: { tag: "v1" } });
    const restored = await restoreSession({ store, snapshotId, model });
    expect(restored.messages.length).toBe(session.messages.length);
  });
});
