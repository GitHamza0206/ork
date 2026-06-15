/**
 * Example 3 — A full agent session ("Claude Code as a library").
 *
 * This is the headline use case: createSession gives you an agent with its own
 * in-memory FS and the 6 tools. You send() a prompt and stream the events as
 * the model reads/writes/greps files and runs bash. The FS changes persist
 * across turns and can be snapshotted to durable storage.
 *
 * REQUIRES AN LLM KEY. The model is routed through the Vercel AI Gateway, so
 * set one of:
 *   export AI_GATEWAY_API_KEY=...        # then model "anthropic/claude-..."
 *   export ANTHROPIC_API_KEY=sk-ant-...  # direct Anthropic (model id below)
 * (No key? Examples 01 and 02 run fully offline.)
 *
 * Run:  pnpm -F @ork.ai/example agent       (or: tsx example/03-agent.ts)
 */
import { createSession } from "@ork.ai/harness";
import { MemorySnapshotStore } from "@ork.ai/kernel";
import { anthropic } from "@ai-sdk/anthropic";

// Two routes to a model:
//  - ANTHROPIC_API_KEY  → direct Anthropic via @ai-sdk/anthropic (used first)
//  - AI_GATEWAY_API_KEY → "provider/model" string via the Vercel AI Gateway
const MODEL = process.env.ANTHROPIC_API_KEY
  ? anthropic("claude-sonnet-4-6")
  : "anthropic/claude-sonnet-4.5";
const MODEL_LABEL = process.env.ANTHROPIC_API_KEY
  ? "claude-sonnet-4-6 (direct Anthropic)"
  : "anthropic/claude-sonnet-4.5 (AI Gateway)";

async function main() {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "No LLM key found. Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY.\n" +
        "Examples 01-shell.ts and 02-tools.ts run with no key.",
    );
    process.exit(1);
  }

  // A session = kernel + shell + tools + the agent loop, all wired together.
  const session = createSession({
    model: MODEL,
    cwd: "/workspace",
    files: {
      "/workspace/data.csv": "name,score\nAlice,91\nBob,72\nCarol,88\n",
    },
    maxSteps: 20, // cap the tool loop
  });

  console.log(`=== ork agent session (model: ${MODEL_LABEL}) ===\n`);

  const prompt =
    "Read /workspace/data.csv, compute the average score with awk or a shell " +
    "pipeline, and write a short markdown summary to /workspace/summary.md " +
    "(include the average and who scored highest). Use the tools.";

  console.log(`user> ${prompt}\n`);

  // send() returns an async stream of typed events. Render them like a live UI.
  for await (const ev of session.send(prompt)) {
    switch (ev.type) {
      case "text_delta":
        process.stdout.write(ev.text);
        break;
      case "tool_call":
        console.log(`\n  [tool] ${ev.tool} ${JSON.stringify(ev.input)}`);
        break;
      case "tool_result":
        console.log(`  [result] ${ev.output.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
        break;
      case "turn_done":
        console.log(`\n\n(turn done — ${ev.stopReason})`);
        break;
      case "error":
        console.error(`\n[error] ${ev.message}`);
        break;
    }
  }

  // The FS the agent built is real and durable. Read its artifact.
  console.log("\n=== files in the session FS ===");
  console.log((await session.listFiles()).join("\n"));

  try {
    const summary = new TextDecoder().decode(await session.readFile("/workspace/summary.md"));
    console.log("\n=== /workspace/summary.md ===\n" + summary);
  } catch {
    console.log("\n(the agent did not create /workspace/summary.md this run)");
  }

  // Snapshot the whole session (FS + conversation) to durable storage. Use
  // DiskSnapshotStore for the filesystem, or an R2/S3 adapter in production.
  const store = new MemorySnapshotStore();
  const { snapshotId } = await session.snapshot(store, { meta: { demo: true } });
  console.log(`\nsnapshot id: ${snapshotId}`);
  console.log("Resume later with restoreSession({ store, snapshotId, model }).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
