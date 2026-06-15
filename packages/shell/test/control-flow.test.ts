import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { writeAll, readAll } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";
import { defaultRegistry } from "../src/registry.js";
import type { CommandImpl } from "../src/types.js";
import type { ShellLimits } from "../src/interpreter.js";

function sh(files: Record<string, string> = {}, limits?: ShellLimits) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel, { limits }), kernel };
}

// A registry including a `seq N` helper (prints 1..N, one per line) so we can
// exercise pipe-into-compound without depending on coreutils.
function shSeq(files: Record<string, string> = {}, limits?: ShellLimits) {
  const kernel = createKernel({ files });
  const registry = defaultRegistry();
  const seq: CommandImpl = async (ctx) => {
    const n = parseInt(ctx.argv[1] ?? "0", 10);
    let out = "";
    for (let i = 1; i <= n; i++) out += i + "\n";
    await writeAll(ctx.stdout, out);
    return 0;
  };
  // upper: uppercases stdin (used to verify pipe stages run).
  const upper: CommandImpl = async (ctx) => {
    const data = await readAll(ctx.stdin);
    await writeAll(ctx.stdout, new TextDecoder().decode(data).toUpperCase());
    return 0;
  };
  registry.register("seq", seq);
  registry.register("upper", upper);
  return { shell: new Shell(kernel, { registry, limits }), kernel };
}

// ---- if --------------------------------------------------------------------

describe("control flow: if", () => {
  it("runs the then-branch when cond is true", async () => {
    const { shell } = sh();
    const r = await shell.exec("if true; then echo yes; fi");
    expect(r.stdout).toBe("yes\n");
    expect(r.exitCode).toBe(0);
  });

  it("skips the then-branch when cond is false, exit 0 with no else", async () => {
    const { shell } = sh();
    const r = await shell.exec("if false; then echo yes; fi");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("runs the else-branch when cond is false", async () => {
    const { shell } = sh();
    const r = await shell.exec("if false; then echo yes; else echo no; fi");
    expect(r.stdout).toBe("no\n");
    expect(r.exitCode).toBe(0);
  });

  it("runs the matching elif branch", async () => {
    const { shell } = sh();
    const r = await shell.exec("if false; then echo a; elif true; then echo b; else echo c; fi");
    expect(r.stdout).toBe("b\n");
  });

  it("falls through elif chain to else", async () => {
    const { shell } = sh();
    const r = await shell.exec("if false; then echo a; elif false; then echo b; else echo c; fi");
    expect(r.stdout).toBe("c\n");
  });

  it("if [ -f /x ] true branch with a seeded file", async () => {
    const { shell } = sh({ "/x": "hi" });
    const r = await shell.exec("if [ -f /x ]; then echo found; fi");
    expect(r.stdout).toBe("found\n");
  });

  it("if [ -f /missing ] takes no branch", async () => {
    const { shell } = sh();
    const r = await shell.exec("if [ -f /missing ]; then echo found; fi");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("exit code is the body's exit code", async () => {
    const { shell } = sh();
    const r = await shell.exec("if true; then false; fi");
    expect(r.exitCode).toBe(1);
  });

  it("cond exit code uses the LAST statement of cond", async () => {
    const { shell } = sh();
    const r = await shell.exec("if false; true; then echo yes; fi");
    expect(r.stdout).toBe("yes\n");
  });
});

// ---- while -----------------------------------------------------------------

describe("control flow: while", () => {
  it("while-false never runs the body", async () => {
    const { shell } = sh();
    const r = await shell.exec("while false; do echo x; done");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("loops while a counter file condition holds", async () => {
    // Count down using test against an env var bumped via cmdsub-free approach:
    // use a for-style counter through reading a seeded list is simpler, but to
    // genuinely exercise while, drain a stdin buffer via read.
    const { shell } = shSeq();
    const r = await shell.exec('seq 3 | while read n; do echo "got $n"; done');
    expect(r.stdout).toBe("got 1\ngot 2\ngot 3\n");
    expect(r.exitCode).toBe(0);
  });

  it("while-read is the canonical agent loop (printf-style via seq)", async () => {
    const { shell } = shSeq();
    const r = await shell.exec('seq 2 | while read v; do echo "[$v]"; done');
    expect(r.stdout).toBe("[1]\n[2]\n");
  });

  it("exit code is the last body exit", async () => {
    const { shell } = shSeq();
    const r = await shell.exec("seq 1 | while read n; do false; done");
    expect(r.exitCode).toBe(1);
  });
});

// ---- for -------------------------------------------------------------------

describe("control flow: for", () => {
  it("iterates a literal list", async () => {
    const { shell } = sh();
    const r = await shell.exec("for x in a b c; do echo $x; done");
    expect(r.stdout).toBe("a\nb\nc\n");
  });

  it("iterates over a glob", async () => {
    const { shell } = sh({ "/a.txt": "1", "/b.txt": "2", "/c.md": "3" });
    const r = await shell.exec("cd /\nfor f in *.txt; do echo $f; done");
    // glob yields absolute matches against cwd (/).
    expect(r.stdout).toBe("/a.txt\n/b.txt\n");
  });

  it("iterates over command substitution", async () => {
    const { shell } = sh();
    const r = await shell.exec("for x in $(echo 1 2 3); do echo $x; done");
    expect(r.stdout).toBe("1\n2\n3\n");
  });

  it("empty list yields no iterations, exit 0", async () => {
    const { shell } = sh();
    const r = await shell.exec("for x in; do echo $x; done");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("sets the loop var in the shell env", async () => {
    const { shell } = sh();
    const r = await shell.exec("for x in one two; do echo $x; done; echo last=$x");
    expect(r.stdout).toBe("one\ntwo\nlast=two\n");
  });
});

// ---- nesting ---------------------------------------------------------------

describe("control flow: nesting", () => {
  it("for inside if", async () => {
    const { shell } = sh();
    const r = await shell.exec("if true; then for x in a b; do echo $x; done; fi");
    expect(r.stdout).toBe("a\nb\n");
  });

  it("if inside for", async () => {
    const { shell } = sh();
    const r = await shell.exec(
      'for x in a b c; do if [ $x = b ]; then echo hit; else echo $x; fi; done',
    );
    expect(r.stdout).toBe("a\nhit\nc\n");
  });

  it("if inside while (read loop)", async () => {
    const { shell } = shSeq();
    const r = await shell.exec(
      'seq 3 | while read n; do if [ $n = 2 ]; then echo two; else echo $n; fi; done',
    );
    expect(r.stdout).toBe("1\ntwo\n3\n");
  });
});

// ---- pipe into compound ----------------------------------------------------

describe("control flow: pipe into compound", () => {
  it("for over cmdsub reading a seeded file", async () => {
    const { shell } = sh({ "/list": "x y z\n" });
    const r = await shell.exec("for w in $(cat /list); do echo got-$w; done");
    expect(r.stdout).toBe("got-x\ngot-y\ngot-z\n");
  });

  it("multi-stage pipe feeding a while-read compound", async () => {
    const { shell } = shSeq();
    // seq 2 → upper (no-op on digits) → while read
    const r = await shell.exec("seq 2 | upper | while read n; do echo n=$n; done");
    expect(r.stdout).toBe("n=1\nn=2\n");
  });

  it("compound mid-pipeline is unsupported", async () => {
    const { shell } = shSeq();
    const r = await shell.exec("for x in a; do echo $x; done | cat");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("only supported as the last stage");
  });
});

// ---- redirections on compounds ---------------------------------------------

describe("control flow: redirections on compounds", () => {
  it("for ... done > /out.txt writes body output to file", async () => {
    const { shell, kernel } = sh();
    const r = await shell.exec("for x in a b; do echo $x; done > /out.txt");
    expect(r.exitCode).toBe(0);
    const data = await kernel.sys.readFile("/out.txt");
    expect(new TextDecoder().decode(data)).toBe("a\nb\n");
  });

  it("while-read with output redirection", async () => {
    const { shell, kernel } = shSeq();
    const r = await shell.exec("seq 3 | while read n; do echo $n; done > /nums.txt");
    expect(r.exitCode).toBe(0);
    const data = await kernel.sys.readFile("/nums.txt");
    expect(new TextDecoder().decode(data)).toBe("1\n2\n3\n");
  });

  it("if ... fi >> appends", async () => {
    const { shell, kernel } = sh({ "/log.txt": "start\n" });
    const r = await shell.exec("if true; then echo more; fi >> /log.txt");
    expect(r.exitCode).toBe(0);
    const data = await kernel.sys.readFile("/log.txt");
    expect(new TextDecoder().decode(data)).toBe("start\nmore\n");
  });

  it("compound < file feeds stdin to read", async () => {
    const { shell } = shSeq({ "/in.txt": "alpha\nbeta\n" });
    const r = await shell.exec("while read line; do echo [$line]; done < /in.txt");
    expect(r.stdout).toBe("[alpha]\n[beta]\n");
  });
});

// ---- execution limits ------------------------------------------------------

describe("execution limits", () => {
  it("while-true aborts at maxLoopIterations", async () => {
    const { shell } = sh({}, { maxLoopIterations: 10 });
    const r = await shell.exec("while true; do :; done");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("loop iteration limit exceeded");
  });

  it("for over a large cmdsub list hits maxCommands", async () => {
    // Build a list of 50 items; body runs echo each → 50 commands + overhead.
    const items = Array.from({ length: 50 }, (_, i) => `i${i}`).join(" ");
    const { shell } = sh({ "/list": items + "\n" }, { maxCommands: 10 });
    const r = await shell.exec("for x in $(cat /list); do echo $x; done");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("command limit exceeded");
  });

  it("for loop with too many items hits maxLoopIterations", async () => {
    const items = Array.from({ length: 50 }, (_, i) => `i${i}`).join(" ");
    const { shell } = sh({}, { maxLoopIterations: 5 });
    const r = await shell.exec(`for x in ${items}; do :; done`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("loop iteration limit exceeded");
  });

  it(": is a no-op alias of true", async () => {
    const { shell } = sh();
    const r = await shell.exec(":");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
