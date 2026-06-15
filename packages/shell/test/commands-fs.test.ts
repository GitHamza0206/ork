import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

const dec = new TextDecoder();
async function readFile(kernel: ReturnType<typeof createKernel>, path: string): Promise<string> {
  return dec.decode(await kernel.sys.readFile(path));
}

// ---- ls --------------------------------------------------------------------
describe("ls", () => {
  it("lists directory entries sorted", async () => {
    const { shell } = sh({ "/d/b": "x", "/d/a": "y", "/d/c": "z" });
    const r = await shell.exec("ls /d");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a\nb\nc\n");
  });

  it("lists cwd when no path given", async () => {
    const { shell } = sh({ "/foo": "1", "/bar": "2" });
    const r = await shell.exec("ls");
    expect(r.stdout).toBe("bar\nfoo\n");
  });

  it("a file path lists just the name", async () => {
    const { shell } = sh({ "/d/file": "x" });
    const r = await shell.exec("ls /d/file");
    expect(r.stdout).toBe("/d/file\n");
  });

  it("hides dotfiles unless -a", async () => {
    const { shell } = sh({ "/d/.hidden": "x", "/d/shown": "y" });
    expect((await shell.exec("ls /d")).stdout).toBe("shown\n");
    expect((await shell.exec("ls -a /d")).stdout).toBe(".hidden\nshown\n");
  });

  it("-l long format prints type+size+name", async () => {
    const { shell } = sh({ "/d/file": "hello" });
    const r = await shell.exec("ls -l /d");
    expect(r.stdout).toBe("-rw-r--r-- 5\tfile\n");
  });

  it("missing path → error, exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("ls /nope");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ls: /nope: No such file or directory");
  });
});

// ---- mkdir -----------------------------------------------------------------
describe("mkdir", () => {
  it("mkdir -p /a/b/c then ls /a/b shows c", async () => {
    const { shell } = sh();
    expect((await shell.exec("mkdir -p /a/b/c")).exitCode).toBe(0);
    expect((await shell.exec("ls /a/b")).stdout).toBe("c\n");
  });

  it("without -p, existing dir errors File exists", async () => {
    const { shell } = sh({ "/a/x": "1" });
    const r = await shell.exec("mkdir /a");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("mkdir: /a: File exists");
  });

  it("without -p, missing parent errors", async () => {
    const { shell } = sh();
    const r = await shell.exec("mkdir /nope/child");
    expect(r.exitCode).toBe(1);
  });
});

// ---- rm --------------------------------------------------------------------
describe("rm", () => {
  it("removes a file", async () => {
    const { shell } = sh({ "/f": "x" });
    expect((await shell.exec("rm /f")).exitCode).toBe(0);
    expect((await shell.exec("test -e /f")).exitCode).toBe(1);
  });

  it("rm -r removes a directory tree", async () => {
    const { shell } = sh({ "/a/b/c": "x", "/a/d": "y" });
    expect((await shell.exec("rm -r /a")).exitCode).toBe(0);
    expect((await shell.exec("test -e /a")).exitCode).toBe(1);
  });

  it("dir without -r → Is a directory, exit 1", async () => {
    const { shell } = sh({ "/a/b": "x" });
    const r = await shell.exec("rm /a");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("rm: /a: Is a directory");
  });

  it("missing without -f → error exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("rm /nope");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("No such file or directory");
  });

  it("missing with -f → no error exit 0", async () => {
    const { shell } = sh();
    const r = await shell.exec("rm -f /nope");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });
});

// ---- cp --------------------------------------------------------------------
describe("cp", () => {
  it("copies file content", async () => {
    const { shell, kernel } = sh({ "/src": "hello world" });
    expect((await shell.exec("cp /src /dst")).exitCode).toBe(0);
    expect(await readFile(kernel, "/dst")).toBe("hello world");
  });

  it("copies into an existing dir as dir/basename", async () => {
    const { shell, kernel } = sh({ "/src": "data", "/d/x": "1" });
    expect((await shell.exec("cp /src /d")).exitCode).toBe(0);
    expect(await readFile(kernel, "/d/src")).toBe("data");
  });

  it("cp -r copies a directory tree", async () => {
    const { shell, kernel } = sh({ "/a/b/c": "deep", "/a/top": "shallow" });
    expect((await shell.exec("cp -r /a /copy")).exitCode).toBe(0);
    expect(await readFile(kernel, "/copy/b/c")).toBe("deep");
    expect(await readFile(kernel, "/copy/top")).toBe("shallow");
  });

  it("dir without -r → error", async () => {
    const { shell } = sh({ "/a/b": "x" });
    const r = await shell.exec("cp /a /dst");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Is a directory");
  });

  it("missing src → exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("cp /nope /dst");
    expect(r.exitCode).toBe(1);
  });
});

// ---- mv --------------------------------------------------------------------
describe("mv", () => {
  it("renames a file", async () => {
    const { shell, kernel } = sh({ "/src": "content" });
    expect((await shell.exec("mv /src /dst")).exitCode).toBe(0);
    expect(await readFile(kernel, "/dst")).toBe("content");
    expect((await shell.exec("test -e /src")).exitCode).toBe(1);
  });

  it("moves into an existing dir", async () => {
    const { shell, kernel } = sh({ "/src": "x", "/d/keep": "1" });
    expect((await shell.exec("mv /src /d")).exitCode).toBe(0);
    expect(await readFile(kernel, "/d/src")).toBe("x");
  });

  it("missing src → exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("mv /nope /dst");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("No such file or directory");
  });
});

// ---- touch -----------------------------------------------------------------
describe("touch", () => {
  it("creates an empty file when missing", async () => {
    const { shell, kernel } = sh();
    expect((await shell.exec("touch /new")).exitCode).toBe(0);
    expect(await readFile(kernel, "/new")).toBe("");
  });

  it("does not truncate an existing file", async () => {
    const { shell, kernel } = sh({ "/f": "keepme" });
    expect((await shell.exec("touch /f")).exitCode).toBe(0);
    expect(await readFile(kernel, "/f")).toBe("keepme");
  });

  it("missing parent → exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("touch /nope/child");
    expect(r.exitCode).toBe(1);
  });
});

// ---- head / tail -----------------------------------------------------------
describe("head / tail", () => {
  const six = "l1\nl2\nl3\nl4\nl5\nl6\n";

  it("head -n 2 of a file", async () => {
    const { shell } = sh({ "/f": six });
    expect((await shell.exec("head -n 2 /f")).stdout).toBe("l1\nl2\n");
  });

  it("head default 10 lines", async () => {
    const { shell } = sh({ "/f": six });
    expect((await shell.exec("head /f")).stdout).toBe(six);
  });

  it("tail -n 1 of a file", async () => {
    const { shell } = sh({ "/f": six });
    expect((await shell.exec("tail -n 1 /f")).stdout).toBe("l6\n");
  });

  it("head from stdin via pipe", async () => {
    const { shell } = sh({ "/f": six });
    expect((await shell.exec("cat /f | head -n 1")).stdout).toBe("l1\n");
  });

  it("multi-file head prints ==> name <== headers", async () => {
    const { shell } = sh({ "/a": "a1\na2\n", "/b": "b1\n" });
    const r = await shell.exec("head -n 1 /a /b");
    expect(r.stdout).toBe("==> /a <==\na1\n\n==> /b <==\nb1\n");
  });

  it("missing file → exit 1", async () => {
    const { shell } = sh();
    expect((await shell.exec("head /nope")).exitCode).toBe(1);
  });
});

// ---- wc --------------------------------------------------------------------
describe("wc", () => {
  it("wc -l counts lines", async () => {
    const { shell } = sh({ "/f": "a\nb\nc\n" });
    expect((await shell.exec("wc -l /f")).stdout).toBe("3 /f\n");
  });

  it("no flags → lines words bytes name", async () => {
    const { shell } = sh({ "/f": "hello world\n" });
    expect((await shell.exec("wc /f")).stdout).toBe("1 2 12 /f\n");
  });

  it("multiple files print a total row", async () => {
    const { shell } = sh({ "/a": "x\n", "/b": "y\nz\n" });
    const r = await shell.exec("wc -l /a /b");
    expect(r.stdout).toBe("1 /a\n2 /b\n3 total\n");
  });

  it("wc from stdin", async () => {
    const { shell } = sh({ "/f": "one two three\n" });
    expect((await shell.exec("cat /f | wc -w")).stdout).toBe("3\n");
  });
});

// ---- printf ----------------------------------------------------------------
describe("printf", () => {
  it("supports %s %d and \\n", async () => {
    const { shell } = sh();
    expect((await shell.exec("printf '%s=%d\\n' foo 42")).stdout).toBe("foo=42\n");
  });

  it("%% prints a literal percent", async () => {
    const { shell } = sh();
    expect((await shell.exec("printf '100%%'")).stdout).toBe("100%");
  });

  it("recycles the format over extra args", async () => {
    const { shell } = sh();
    expect((await shell.exec("printf '%s\\n' a b c")).stdout).toBe("a\nb\nc\n");
  });

  it("missing args → empty / 0", async () => {
    const { shell } = sh();
    expect((await shell.exec("printf '%s:%d'")).stdout).toBe(":0");
  });
});

// ---- tee -------------------------------------------------------------------
describe("tee", () => {
  it("writes stdin to a file and passes it through", async () => {
    const { shell, kernel } = sh({ "/f": "payload\n" });
    const r = await shell.exec("cat /f | tee /t.txt");
    expect(r.stdout).toBe("payload\n");
    expect(await readFile(kernel, "/t.txt")).toBe("payload\n");
  });

  it("tee -a appends", async () => {
    const { shell, kernel } = sh({ "/t.txt": "first\n", "/src": "second\n" });
    await shell.exec("cat /src | tee -a /t.txt");
    expect(await readFile(kernel, "/t.txt")).toBe("first\nsecond\n");
  });
});

// ---- base64 ----------------------------------------------------------------
describe("base64", () => {
  it("round-trips through encode and decode", async () => {
    const { shell } = sh({ "/f": "Hello, ork!" });
    const enc = (await shell.exec("base64 /f")).stdout.trim();
    expect(enc).toBe("SGVsbG8sIG9yayE=");
    const r = await shell.exec(`printf '%s' '${enc}' | base64 -d`);
    expect(r.stdout).toBe("Hello, ork!");
  });
});

// ---- cut -------------------------------------------------------------------
describe("cut", () => {
  it("cut -d: -f1 extracts first field", async () => {
    const { shell } = sh({ "/f": "a:b:c\nd:e:f\n" });
    expect((await shell.exec("cut -d: -f1 /f")).stdout).toBe("a\nd\n");
  });

  it("cut -d: -f2-3 extracts a range", async () => {
    const { shell } = sh({ "/f": "a:b:c:d\n" });
    expect((await shell.exec("cut -d: -f2-3 /f")).stdout).toBe("b:c\n");
  });

  it("cut -c extracts characters", async () => {
    const { shell } = sh({ "/f": "abcdef\n" });
    expect((await shell.exec("cut -c1-3 /f")).stdout).toBe("abc\n");
  });

  it("cut -f comma list", async () => {
    const { shell } = sh({ "/f": "1:2:3:4\n" });
    expect((await shell.exec("cut -d: -f1,3 /f")).stdout).toBe("1:3\n");
  });

  it("reads from stdin", async () => {
    const { shell } = sh();
    expect((await shell.exec("printf 'x,y,z\\n' | cut -d, -f2")).stdout).toBe("y\n");
  });
});

// ---- env -------------------------------------------------------------------
describe("env", () => {
  it("prints KEY=VALUE sorted after assignment", async () => {
    const { shell } = sh();
    const r = await shell.exec("FOO=bar env");
    expect(r.stdout).toContain("FOO=bar\n");
  });
});

// ---- date ------------------------------------------------------------------
describe("date", () => {
  it("prints an ISO 8601 timestamp", async () => {
    const { shell } = sh();
    const r = await shell.exec("date");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---- which -----------------------------------------------------------------
describe("which", () => {
  it("reports a registered builtin", async () => {
    const { shell } = sh();
    const r = await shell.exec("which cat");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("cat\n");
  });

  it("reports a shell-state builtin (cd)", async () => {
    const { shell } = sh();
    expect((await shell.exec("which cd")).stdout).toBe("cd\n");
  });

  it("unknown name → exit 1, no output", async () => {
    const { shell } = sh();
    const r = await shell.exec("which nosuchtool");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });
});
