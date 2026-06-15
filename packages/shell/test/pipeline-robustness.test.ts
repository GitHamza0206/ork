import { describe, it, expect } from "vitest";
import { createKernel, writeAll } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";
import { defaultRegistry } from "../src/registry.js";
import type { CommandImpl } from "../src/types.js";

// ---- helpers --------------------------------------------------------------

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

// A registry plus a "yes-like" producer that writes way past the pipe HWM
// (1024 chunks) and only completes once its stdout is fully drained, and an
// "exit0" consumer that returns immediately WITHOUT reading its stdin. Wired as
// `producer | exit0` this deadlocks the naive Promise.all(collectors): the
// producer blocks on stdout backpressure forever.
function shBlocking(opts: { timeoutMs?: number } = {}) {
  const kernel = createKernel({});
  const registry = defaultRegistry();

  // Writes 5000 single-byte chunks to stdout. Far past the 1024 HWM, so it
  // blocks unless the consumer drains.
  const flood: CommandImpl = async (ctx) => {
    const w = ctx.stdout.getWriter();
    for (let i = 0; i < 5000; i++) {
      await w.write(new TextEncoder().encode("x"));
    }
    await w.close();
    return 0;
  };
  // Returns immediately, never touches stdin.
  const exit0: CommandImpl = async () => 0;

  registry.register("flood", flood);
  registry.register("exit0", exit0);
  return { shell: new Shell(kernel, { registry, timeoutMs: opts.timeoutMs }), kernel };
}

// ---- Issue #1: pipeline deadlock backstop ---------------------------------

describe("pipeline robustness: deadlock backstop", () => {
  it("a would-deadlock pipeline completes (teardown or timeout), no hang", async () => {
    const { shell } = shBlocking({ timeoutMs: 300 });
    const start = Date.now();
    const r = await shell.exec("flood | exit0");
    const elapsed = Date.now() - start;
    // Must complete. Either upstream teardown returns ~immediately (exit 0),
    // or the wall-clock timeout fires at exit 124.
    expect([0, 124]).toContain(r.exitCode);
    // And it must not have waited anywhere near forever.
    expect(elapsed).toBeLessThan(2000);
  });

  it("a pipeline whose terminal proc never exits times out at 124", async () => {
    const kernel = createKernel({});
    const registry = defaultRegistry();
    // Never resolves until stdin EOF, but stdin never closes from upstream
    // here (it's the only proc and we feed empty stdin -> would EOF). To force
    // a hang, ignore stdin and await a promise that never settles.
    const hang: CommandImpl = async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
      return 0;
    };
    registry.register("hang", hang);
    const shell = new Shell(kernel, { registry, timeoutMs: 200 });
    const start = Date.now();
    const r = await shell.exec("hang");
    const elapsed = Date.now() - start;
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("pipeline timed out");
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---- Issue #3: 2>&1 on a non-last stage routes into the pipe --------------

describe("pipeline robustness: 2>&1 routing into downstream pipe", () => {
  it("cat /nope 2>&1 | grep -c 'No such' counts the error line", async () => {
    const { shell } = sh();
    const r = await shell.exec("cat /nope 2>&1 | grep -c 'No such'");
    expect(r.stdout).toBe("1\n");
    expect(r.exitCode).toBe(0);
    // The error text must NOT leak to the final sink stderr.
    expect(r.stderr).toBe("");
  });

  it("cat /nope 2>&1 | cat shows the error text on stdout", async () => {
    const { shell } = sh();
    const r = await shell.exec("cat /nope 2>&1 | cat");
    expect(r.stdout).toContain("No such file or directory");
    expect(r.stderr).toBe("");
  });
});

// ---- Issue #2: command-limit abort through spawned procs (xargs) ----------

describe("pipeline robustness: command limit through xargs", () => {
  it("exceeding maxCommands via xargs aborts exec with exit 2, message on stderr only", async () => {
    const kernel = createKernel({});
    const shell = new Shell(kernel, { limits: { maxCommands: 5 } });
    const r = await shell.exec('echo "a b c d e f g h" | xargs -n1 echo');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("ork-shell: command limit exceeded");
    // The limit message must NOT be in stdout.
    expect(r.stdout).not.toContain("command limit exceeded");
  });
});
