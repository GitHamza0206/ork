import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";
import { parseOpts } from "../src/commands/util.js";

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

// ============================ parseOpts (unit) ==============================
describe("parseOpts", () => {
  it("separate value flag: -t ,", () => {
    const r = parseOpts(["-t", ","], { value: "t" });
    expect(r.values.get("t")).toBe(",");
    expect(r.positional).toEqual([]);
  });

  it("attached value flag: -t,", () => {
    const r = parseOpts(["-t,"], { value: "t" });
    expect(r.values.get("t")).toBe(",");
  });

  it("attached numeric value: -k2 / -n10", () => {
    expect(parseOpts(["-k2"], { value: "k" }).values.get("k")).toBe("2");
    expect(parseOpts(["-n10"], { value: "n" }).values.get("n")).toBe("10");
  });

  it("clustered booleans: -nr", () => {
    const r = parseOpts(["-nr"], { bool: "nru" });
    expect(r.flags.has("n")).toBe(true);
    expect(r.flags.has("r")).toBe(true);
  });

  it("cluster of booleans then attached value flag: -nrk2", () => {
    const r = parseOpts(["-nrk2"], { bool: "nru", value: "k" });
    expect(r.flags.has("n")).toBe(true);
    expect(r.flags.has("r")).toBe(true);
    expect(r.values.get("k")).toBe("2");
  });

  it("value flag ending a cluster consumes next arg: -nk 2", () => {
    const r = parseOpts(["-nk", "2"], { bool: "n", value: "k" });
    expect(r.flags.has("n")).toBe(true);
    expect(r.values.get("k")).toBe("2");
  });

  it("intermixed operand then flag: file -k2", () => {
    const r = parseOpts(["file", "-k2"], { value: "k" });
    expect(r.positional).toEqual(["file"]);
    expect(r.values.get("k")).toBe("2");
  });

  it("-- stops option parsing", () => {
    const r = parseOpts(["-n", "--", "-k2"], { bool: "n", value: "k" });
    expect(r.flags.has("n")).toBe(true);
    expect(r.positional).toEqual(["-k2"]);
    expect(r.values.has("k")).toBe(false);
  });

  it("unknown flag token falls through to positional", () => {
    const r = parseOpts(["-z", "x"], { bool: "n" });
    expect(r.positional).toEqual(["-z", "x"]);
  });

  it("missing value reports error", () => {
    const r = parseOpts(["-k"], { value: "k" });
    expect(r.error).toBe("k");
  });
});

// ============================ sort =========================================
describe("sort attached flags", () => {
  it("sort -t, -k2 -n -r numeric desc by field 2", async () => {
    const { shell } = sh();
    const r = await shell.exec(`printf 'a,2\\nb,10\\nc,1\\n' | sort -t, -k2 -n -r`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("b,10\na,2\nc,1\n");
  });

  it("sort -t',' -k2 through the shell (quote removal)", async () => {
    const { shell } = sh();
    const r = await shell.exec(`printf 'a,2\\nb,10\\nc,1\\n' | sort -t',' -k2 -n`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("c,1\na,2\nb,10\n");
  });

  it("clustered -nr regression", async () => {
    const { shell } = sh();
    const r = await shell.exec(`printf '3\\n1\\n10\\n' | sort -nr`);
    expect(r.stdout).toBe("10\n3\n1\n");
  });

  it("the exact real-world failing command via shell.exec", async () => {
    const { shell } = sh({ "/data.csv": "x,2\ny,10\nz,1\nw,5\n" });
    const r = await shell.exec(`tail -n 3 /data.csv | sort -t',' -k2 -n`);
    expect(r.exitCode).toBe(0);
    // tail -n 3 → y,10 / z,1 / w,5 ; sort numeric by field 2 asc → z,1 w,5 y,10
    expect(r.stdout).toBe("z,1\nw,5\ny,10\n");
  });
});

// ============================ head / tail ==================================
describe("head/tail attached flags", () => {
  const f = { "/n.txt": "1\n2\n3\n4\n5\n" };

  it("head -3 == head -n3 == head -n 3", async () => {
    const a = (await sh(f).shell.exec("head -3 /n.txt")).stdout;
    const b = (await sh(f).shell.exec("head -n3 /n.txt")).stdout;
    const c = (await sh(f).shell.exec("head -n 3 /n.txt")).stdout;
    expect(a).toBe("1\n2\n3\n");
    expect(b).toBe("1\n2\n3\n");
    expect(c).toBe("1\n2\n3\n");
  });

  it("tail -2 == tail -n2 == tail -n 2", async () => {
    const a = (await sh(f).shell.exec("tail -2 /n.txt")).stdout;
    const b = (await sh(f).shell.exec("tail -n2 /n.txt")).stdout;
    const c = (await sh(f).shell.exec("tail -n 2 /n.txt")).stdout;
    expect(a).toBe("4\n5\n");
    expect(b).toBe("4\n5\n");
    expect(c).toBe("4\n5\n");
  });
});

// ============================ cut ==========================================
describe("cut attached flags", () => {
  it("cut -d, -f1 == cut -d , -f 1", async () => {
    const f = { "/c.csv": "a,b,c\nd,e,f\n" };
    const a = (await sh(f).shell.exec("cut -d, -f1 /c.csv")).stdout;
    const b = (await sh(f).shell.exec("cut -d , -f 1 /c.csv")).stdout;
    expect(a).toBe("a\nd\n");
    expect(b).toBe("a\nd\n");
  });

  it("cut -d: -f2,3", async () => {
    const f = { "/c.txt": "1:2:3:4\n" };
    const r = await sh(f).shell.exec("cut -d: -f2,3 /c.txt");
    expect(r.stdout).toBe("2:3\n");
  });
});

// ============================ xargs ========================================
describe("xargs attached flags", () => {
  it("xargs -n1 echo (separate and attached)", async () => {
    const a = await sh().shell.exec(`printf 'a b c\\n' | xargs -n1 echo`);
    expect(a.stdout).toBe("a\nb\nc\n");
    const b = await sh().shell.exec(`printf 'a b c\\n' | xargs -n 1 echo`);
    expect(b.stdout).toBe("a\nb\nc\n");
  });

  it("xargs -I{} echo {} attached", async () => {
    const r = await sh().shell.exec(`printf 'x\\ny\\n' | xargs -I{} echo got {}`);
    expect(r.stdout).toBe("got x\ngot y\n");
  });
});

// ============================ grep =========================================
describe("grep clustered booleans regression", () => {
  it("grep -in pattern file", async () => {
    const f = { "/p.txt": "Alpha\nbeta\nALPHA\n" };
    const r = await sh(f).shell.exec("grep -in alpha /p.txt");
    expect(r.stdout).toBe("1:Alpha\n3:ALPHA\n");
  });
});

// ============================ sed ==========================================
describe("sed attached -e", () => {
  it("sed -e's/a/X/' attached script", async () => {
    const r = await sh().shell.exec(`printf 'abc\\n' | sed -e 's/a/X/'`);
    expect(r.stdout).toBe("Xbc\n");
  });
});

// ============================ ls regression ================================
describe("ls clustered booleans regression", () => {
  it("ls -la", async () => {
    const f = { "/d/.h": "x", "/d/a": "y" };
    const r = await sh(f).shell.exec("ls -la /d");
    expect(r.stdout).toContain(".h");
    expect(r.stdout).toContain("a");
  });
});
