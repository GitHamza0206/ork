import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

// ---- string tests ----------------------------------------------------------

describe("test builtin: strings", () => {
  it("-z true on empty string", async () => {
    expect((await sh().shell.exec('test -z ""')).exitCode).toBe(0);
  });
  it("-z false on non-empty", async () => {
    expect((await sh().shell.exec("test -z hi")).exitCode).toBe(1);
  });
  it("-n true on non-empty", async () => {
    expect((await sh().shell.exec("test -n hi")).exitCode).toBe(0);
  });
  it("-n false on empty", async () => {
    expect((await sh().shell.exec('test -n ""')).exitCode).toBe(1);
  });
  it("bare non-empty string is true", async () => {
    expect((await sh().shell.exec("test hi")).exitCode).toBe(0);
  });
  it("bare empty string is false", async () => {
    expect((await sh().shell.exec('test ""')).exitCode).toBe(1);
  });
  it("= compares equal strings", async () => {
    expect((await sh().shell.exec("test foo = foo")).exitCode).toBe(0);
    expect((await sh().shell.exec("test foo = bar")).exitCode).toBe(1);
  });
  it("!= compares strings", async () => {
    expect((await sh().shell.exec("test foo != bar")).exitCode).toBe(0);
    expect((await sh().shell.exec("test foo != foo")).exitCode).toBe(1);
  });
});

// ---- integer tests ---------------------------------------------------------

describe("test builtin: integers", () => {
  it("-eq / -ne", async () => {
    expect((await sh().shell.exec("test 3 -eq 3")).exitCode).toBe(0);
    expect((await sh().shell.exec("test 3 -ne 4")).exitCode).toBe(0);
    expect((await sh().shell.exec("test 3 -eq 4")).exitCode).toBe(1);
  });
  it("-lt / -le / -gt / -ge", async () => {
    expect((await sh().shell.exec("test 2 -lt 3")).exitCode).toBe(0);
    expect((await sh().shell.exec("test 3 -le 3")).exitCode).toBe(0);
    expect((await sh().shell.exec("test 4 -gt 3")).exitCode).toBe(0);
    expect((await sh().shell.exec("test 3 -ge 4")).exitCode).toBe(1);
  });
  it("non-integer operand is a usage error (exit 2)", async () => {
    const r = await sh().shell.exec("test foo -eq 3");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("integer expression expected");
  });
  it("negative integers parse", async () => {
    expect((await sh().shell.exec("test -5 -lt 0")).exitCode).toBe(0);
  });
});

// ---- file tests ------------------------------------------------------------

describe("test builtin: files", () => {
  it("-e on an existing file", async () => {
    expect((await sh({ "/f": "x" }).shell.exec("test -e /f")).exitCode).toBe(0);
  });
  it("-e on a missing path is false", async () => {
    expect((await sh().shell.exec("test -e /nope")).exitCode).toBe(1);
  });
  it("-f true for a regular file", async () => {
    expect((await sh({ "/f": "x" }).shell.exec("test -f /f")).exitCode).toBe(0);
  });
  it("-d true for a directory", async () => {
    expect((await sh({ "/dir/inner": "x" }).shell.exec("test -d /dir")).exitCode).toBe(0);
  });
  it("-f false for a directory", async () => {
    expect((await sh({ "/dir/inner": "x" }).shell.exec("test -f /dir")).exitCode).toBe(1);
  });
  it("-s true when file has size > 0", async () => {
    expect((await sh({ "/f": "data" }).shell.exec("test -s /f")).exitCode).toBe(0);
  });
  it("-s false for an empty file", async () => {
    expect((await sh({ "/empty": "" }).shell.exec("test -s /empty")).exitCode).toBe(1);
  });
});

// ---- logic / negation ------------------------------------------------------

describe("test builtin: negation and edge cases", () => {
  it("! negates", async () => {
    expect((await sh().shell.exec("test ! -z hi")).exitCode).toBe(0);
    expect((await sh().shell.exec('test ! -z ""')).exitCode).toBe(1);
  });
  it("no args → false (exit 1)", async () => {
    expect((await sh().shell.exec("test")).exitCode).toBe(1);
  });
  it("unknown unary operator is a usage error", async () => {
    const r = await sh().shell.exec("test -q foo");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unary operator expected");
  });
});

// ---- the [ form ------------------------------------------------------------

describe("[ builtin", () => {
  it("[ requires a closing ]", async () => {
    const r = await sh().shell.exec("[ -z x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing ']'");
  });
  it("[ x = x ] true", async () => {
    expect((await sh().shell.exec("[ x = x ]")).exitCode).toBe(0);
  });
  it("[ ] with no args → false", async () => {
    expect((await sh().shell.exec("[ ]")).exitCode).toBe(1);
  });
  it("[ -f /f ] against seeded VFS", async () => {
    expect((await sh({ "/f": "x" }).shell.exec("[ -f /f ]")).exitCode).toBe(0);
  });
  it("[ 3 -gt 2 ] true", async () => {
    expect((await sh().shell.exec("[ 3 -gt 2 ]")).exitCode).toBe(0);
  });
  it("integer-vs-string: [ 10 -gt 9 ] not lexicographic", async () => {
    // String "10" < "9" lexically, but -gt is numeric so 10 > 9 is true.
    expect((await sh().shell.exec("[ 10 -gt 9 ]")).exitCode).toBe(0);
  });
});
