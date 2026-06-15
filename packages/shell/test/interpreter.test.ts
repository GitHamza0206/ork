import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { writeAll } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";
import { defaultRegistry } from "../src/registry.js";
import type { CommandImpl } from "../src/types.js";

// ---- helpers --------------------------------------------------------------

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

// A registry with extra test-only commands for inspecting argv.
function shWithTestCmds(files: Record<string, string> = {}, env?: Record<string, string>) {
  const kernel = createKernel({ files });
  const registry = defaultRegistry();
  // argc: prints the number of args (argv minus the command name).
  const argc: CommandImpl = async (ctx) => {
    await writeAll(ctx.stdout, String(ctx.argv.length - 1) + "\n");
    return 0;
  };
  // showenv NAME: prints the value of env var NAME from the command's env.
  const showenv: CommandImpl = async (ctx) => {
    const name = ctx.argv[1] ?? "";
    await writeAll(ctx.stdout, (ctx.env.get(name) ?? "") + "\n");
    return 0;
  };
  registry.register("argc", argc);
  registry.register("showenv", showenv);
  return { shell: new Shell(kernel, { registry, env }), kernel };
}

// ---- echo / cat / basic ---------------------------------------------------

describe("interpreter: basic commands", () => {
  it("echo joins args with spaces and trailing newline", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo hello world");
    expect(r.stdout).toBe("hello world\n");
    expect(r.exitCode).toBe(0);
  });

  it("echo -n suppresses the trailing newline", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo -n hi");
    expect(r.stdout).toBe("hi");
  });

  it("cat reads a file", async () => {
    const { shell } = sh({ "/data/x": "contents\n" });
    const r = await shell.exec("cat /data/x");
    expect(r.stdout).toBe("contents\n");
    expect(r.exitCode).toBe(0);
  });

  it("cat on a missing file reports error and exits 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("cat /nope");
    expect(r.stderr).toBe("cat: /nope: No such file or directory\n");
    expect(r.exitCode).toBe(1);
  });

  it("pwd prints the cwd", async () => {
    const { shell } = sh();
    const r = await shell.exec("pwd");
    expect(r.stdout).toBe("/\n");
  });
});

// ---- pipelines ------------------------------------------------------------

describe("interpreter: pipelines", () => {
  it("echo hi | cat passes stdin through", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo hi | cat");
    expect(r.stdout).toBe("hi\n");
    expect(r.exitCode).toBe(0);
  });

  it("3-stage pipeline cat | cat | cat", async () => {
    const { shell } = sh({ "/data/x": "z\n" });
    const r = await shell.exec("cat /data/x | cat | cat");
    expect(r.stdout).toBe("z\n");
  });

  it("pipeline exit code is the last command's", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo hi | false");
    expect(r.exitCode).toBe(1);
  });

  it("command-not-found inside a pipeline does not crash others", async () => {
    const { shell } = sh();
    const r = await shell.exec("nosuchcmd | echo ok");
    expect(r.stdout).toBe("ok\n");
    expect(r.stderr).toContain("nosuchcmd: command not found");
    expect(r.exitCode).toBe(0); // last command succeeds
  });
});

// ---- exit codes & and/or --------------------------------------------------

describe("interpreter: exit codes and && ||", () => {
  it("false yields exit code 1", async () => {
    const { shell } = sh();
    expect((await shell.exec("false")).exitCode).toBe(1);
  });

  it("true && echo y runs the rhs", async () => {
    const { shell } = sh();
    const r = await shell.exec("true && echo y");
    expect(r.stdout).toBe("y\n");
  });

  it("false && echo n skips the rhs", async () => {
    const { shell } = sh();
    const r = await shell.exec("false && echo n");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("false || echo y runs the rhs", async () => {
    const { shell } = sh();
    const r = await shell.exec("false || echo y");
    expect(r.stdout).toBe("y\n");
    expect(r.exitCode).toBe(0);
  });

  it("$? reflects the last exit code", async () => {
    const { shell } = sh();
    const r = await shell.exec("false; echo $?");
    expect(r.stdout).toBe("1\n");
  });
});

// ---- redirections ---------------------------------------------------------

describe("interpreter: redirections", () => {
  it("> writes stdout to a file (truncate)", async () => {
    const { shell, kernel } = sh();
    const r = await shell.exec("echo hi > /out.txt");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
    const written = new TextDecoder().decode(await kernel.sys.readFile("/out.txt"));
    expect(written).toBe("hi\n");
  });

  it(">> appends to an existing file", async () => {
    const { shell, kernel } = sh({ "/out.txt": "a\n" });
    await shell.exec("echo b >> /out.txt");
    const written = new TextDecoder().decode(await kernel.sys.readFile("/out.txt"));
    expect(written).toBe("a\nb\n");
  });

  it("< reads a file as stdin", async () => {
    const { shell } = sh({ "/in.txt": "fromfile\n" });
    const r = await shell.exec("cat < /in.txt");
    expect(r.stdout).toBe("fromfile\n");
  });

  it("< on a missing file errors and does not run the command", async () => {
    const { shell } = sh();
    const r = await shell.exec("cat < /nope");
    expect(r.stderr).toBe("ork-shell: /nope: No such file or directory\n");
    expect(r.exitCode).toBe(1);
  });

  it("2> redirects stderr to a file", async () => {
    const { shell, kernel } = sh();
    const r = await shell.exec("cat /missing 2> /err.txt");
    expect(r.stderr).toBe("");
    const err = new TextDecoder().decode(await kernel.sys.readFile("/err.txt"));
    expect(err).toBe("cat: /missing: No such file or directory\n");
  });

  it("2>&1 merges stderr into stdout", async () => {
    const { shell } = sh();
    const r = await shell.exec("cat /missing 2>&1");
    expect(r.stdout).toContain("cat: /missing: No such file or directory");
    expect(r.stderr).toBe("");
  });

  it("> into a missing directory errors and exits 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo hi > /nodir/out.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("/nodir/out.txt");
  });
});

// ---- heredocs -------------------------------------------------------------

describe("interpreter: heredocs", () => {
  it("heredoc feeds the body as stdin with var expansion", async () => {
    const { shell } = sh();
    const r = await shell.exec("FOO=bar\ncat <<EOF\nhello $FOO\nEOF");
    expect(r.stdout).toBe("hello bar\n");
  });

  it("quoted heredoc delimiter disables expansion", async () => {
    const { shell } = sh();
    const r = await shell.exec("FOO=bar\ncat <<'EOF'\nhello $FOO\nEOF");
    expect(r.stdout).toBe("hello $FOO\n");
  });
});

// ---- variables ------------------------------------------------------------

describe("interpreter: variables", () => {
  it("assignment then echo $FOO", async () => {
    const { shell } = sh();
    const r = await shell.exec("FOO=hello\necho $FOO");
    expect(r.stdout).toBe("hello\n");
  });

  it("${FOO} braces form", async () => {
    const { shell } = sh();
    const r = await shell.exec("FOO=hi\necho ${FOO}x");
    expect(r.stdout).toBe("hix\n");
  });

  it("undefined variable expands to empty", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo [$NOPE]");
    expect(r.stdout).toBe("[]\n");
  });

  it("prefix assignment is visible to that command only", async () => {
    const { shell } = shWithTestCmds();
    const r = await shell.exec("FOO=bar showenv FOO");
    expect(r.stdout).toBe("bar\n");
    // The shell env is unaffected afterwards.
    const r2 = await shell.exec("showenv FOO");
    expect(r2.stdout).toBe("\n");
  });

  it("unquoted $FOO field-splits; quoted is a single field", async () => {
    const { shell } = shWithTestCmds();
    const split = await shell.exec('FOO="a b c"\nargc $FOO');
    expect(split.stdout).toBe("3\n");
    const single = await shell.exec('FOO="a b c"\nargc "$FOO"');
    expect(single.stdout).toBe("1\n");
  });
});

// ---- command substitution -------------------------------------------------

describe("interpreter: command substitution", () => {
  it("echo $(echo hi)", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo $(echo hi)");
    expect(r.stdout).toBe("hi\n");
  });

  it("nested command substitution", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo $(echo $(echo deep))");
    expect(r.stdout).toBe("deep\n");
  });

  it("trailing newlines are stripped from cmdsub output", async () => {
    const { shell } = sh({ "/f": "x\n\n\n" });
    const r = await shell.exec("echo [$(cat /f)]");
    expect(r.stdout).toBe("[x]\n");
  });

  it("$(false) sets $? to 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("$(false)\necho $?");
    // The empty expansion of $(false) yields no command; $? reflects the cmdsub exit.
    expect(r.stdout.trim().endsWith("1")).toBe(true);
  });
});

// ---- globs ----------------------------------------------------------------

describe("interpreter: globs", () => {
  const files = { "/a.txt": "1", "/b.txt": "2", "/sub/c.txt": "3", "/sub/d.log": "4" };

  it("*.txt expands sorted at cwd", async () => {
    const { shell } = sh(files);
    const r = await shell.exec("echo *.txt");
    expect(r.stdout).toBe("/a.txt /b.txt\n");
  });

  it("no match keeps the literal pattern", async () => {
    const { shell } = sh(files);
    const r = await shell.exec("echo *.zzz");
    expect(r.stdout).toBe("*.zzz\n");
  });

  it('quoted "*.txt" is literal', async () => {
    const { shell } = sh(files);
    const r = await shell.exec('echo "*.txt"');
    expect(r.stdout).toBe("*.txt\n");
  });

  it("glob in subdirectory /sub/*.txt", async () => {
    const { shell } = sh(files);
    const r = await shell.exec("echo /sub/*.txt");
    expect(r.stdout).toBe("/sub/c.txt\n");
  });
});

// ---- cd / pwd -------------------------------------------------------------

describe("interpreter: cd and pwd", () => {
  it("cd then pwd reflects the new cwd", async () => {
    const { shell } = sh({ "/sub/c.txt": "x" });
    const r = await shell.exec("cd /sub\npwd");
    expect(r.stdout).toBe("/sub\n");
  });

  it("relative paths resolve against cwd", async () => {
    const { shell } = sh({ "/sub/c.txt": "ok" });
    const r = await shell.exec("cd /sub\ncat c.txt");
    expect(r.stdout).toBe("ok");
  });

  it("cd into a missing dir errors and exits 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("cd /nope");
    expect(r.stderr).toBe("cd: /nope: No such file or directory\n");
    expect(r.exitCode).toBe(1);
  });

  it("cd with no args goes to HOME (default /)", async () => {
    const { shell } = sh({ "/sub/x": "1" });
    const r = await shell.exec("cd /sub\ncd\npwd");
    expect(r.stdout).toBe("/\n");
  });
});

// ---- errors & misc --------------------------------------------------------

describe("interpreter: errors and edge cases", () => {
  it("unknown command -> 127 and message", async () => {
    const { shell } = sh();
    const r = await shell.exec("frobnicate");
    expect(r.stderr).toBe("ork-shell: frobnicate: command not found\n");
    expect(r.exitCode).toBe(127);
  });

  it("a parse error returns exitCode 2 with an ork-shell message", async () => {
    const { shell } = sh();
    const r = await shell.exec("if");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/^ork-shell: /);
  });

  it("compound commands now execute (control flow implemented)", async () => {
    const { shell } = sh();
    const r = await shell.exec("if true; then echo y; fi");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("y\n");
  });

  it("background command output appears (exec awaits background)", async () => {
    const { shell, kernel } = sh();
    const r = await shell.exec("echo bg > /bg.txt &\necho done");
    expect(r.stdout).toBe("done\n");
    const written = new TextDecoder().decode(await kernel.sys.readFile("/bg.txt"));
    expect(written).toBe("bg\n");
  });
});
