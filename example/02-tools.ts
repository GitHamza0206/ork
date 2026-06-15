/**
 * Example 2 — The 6 Claude-Code-style tools, no LLM, no API key.
 *
 * @ork.ai/tools exposes Bash / Read / Write / Edit / Glob / Grep as AI SDK tools.
 * Here we call them directly (via createTools(...).<Tool>.execute) to show
 * exactly what an agent would do and what the model sees back. The tool outputs
 * are the strings that get fed to the LLM — note the `cat -n` line numbers,
 * the self-correctable error strings, etc.
 *
 * Run:  pnpm -F @ork.ai/example tools      (or: tsx example/02-tools.ts)
 */
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "@ork.ai/shell";
import { createTools } from "@ork.ai/tools";

async function main() {
  const kernel = createKernel({
    files: {
      "/src/app.ts": `export function greet(name: string) {\n  return "hi " + name;\n}\n`,
      "/src/util.ts": `export const PI = 3.14;\n`,
    },
  });
  const shell = new Shell(kernel, { cwd: "/" });

  // Tools are bound to a context: { sys, shell, cwd }. createTools returns the
  // AI SDK tool objects an agent loop would hand to the model.
  const tools = createTools({ sys: kernel.sys, shell, cwd: "/" });

  // The model invokes a tool by calling its execute() with a typed input.
  // execute() always returns a string (never throws) — that string is the
  // model-facing result.
  // The agent loop normally calls a tool's execute(input, options). Here we call
  // it directly with a stub options object to demo the result the model sees.
  const call = async (name: keyof typeof tools, input: unknown) => {
    const tool = tools[name] as unknown as {
      execute: (i: unknown, o: unknown) => Promise<string>;
    };
    const out = await tool.execute(input, { toolCallId: "demo", messages: [] });
    console.log(`>>> ${name}(${JSON.stringify(input)})`);
    console.log(out);
    console.log("");
  };

  console.log("=== ork tools: what the agent calls, what the model sees ===\n");

  // Glob: find files.
  await call("Glob", { pattern: "**/*.ts" });

  // Read: cat -n formatting (line numbers the model can reference in Edit).
  await call("Read", { file_path: "/src/app.ts" });

  // Grep: search across files.
  await call("Grep", { pattern: "export", path: "/src", output_mode: "content", line_numbers: true });

  // Edit: surgical string replacement (errors are returned, not thrown).
  await call("Edit", {
    file_path: "/src/app.ts",
    old_string: `return "hi " + name;`,
    new_string: "return `hi ${name}!`;",
  });
  await call("Read", { file_path: "/src/app.ts" });

  // A self-correctable error: old_string not found → the model gets a clear
  // message and can retry, instead of the loop crashing.
  await call("Edit", { file_path: "/src/app.ts", old_string: "does-not-exist", new_string: "x" });

  // Write: creates parent dirs automatically.
  await call("Write", { file_path: "/dist/notes.txt", content: "built\n" });

  // Bash: run a whole pipeline through the shell.
  await call("Bash", { command: "find / -type f | sort | head -n 20" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
