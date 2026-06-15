import { describe, it, expect } from "vitest";
import { createKernel } from "@ork.ai/kernel";
import { Shell } from "../src/interpreter.js";

function sh(files: Record<string, string> = {}) {
  const kernel = createKernel({ files });
  return { shell: new Shell(kernel), kernel };
}

// Seeded VFS used across many cases.
function seeded() {
  return sh({
    "/poem.txt": "alpha\nBeta\ngamma\nalpha beta\nDelta\n",
    "/nums.txt": "3\n1\n10\n2\n1\n",
    "/dup.txt": "a\na\nb\nb\nb\nc\na\n",
    "/csv.txt": "bob,30\nann,25\ncarl,40\n",
    "/tree/a.txt": "hello\nfoo\n",
    "/tree/sub/b.txt": "foo bar\nbaz\n",
    "/tree/sub/c.log": "nothing\n",
    "/data.json": JSON.stringify({
      name: "acme",
      count: 3,
      users: [
        { name: "ann", email: "ann@x.com", age: 30 },
        { name: "bob", email: "bob@x.com", age: 25 },
        { name: "ann", email: "ann2@x.com", age: 40 },
      ],
      nested: { a: { b: "deep" } },
    }),
    "/arr.json": JSON.stringify([10, 20, 30]),
    "/f1.txt": "one\ntwo\nthree\n",
    "/f2.txt": "one\nTWO\nthree\nfour\n",
  });
}

// ============================ grep =========================================
describe("grep", () => {
  it("basic match from stdin, exit 0", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep alpha /poem.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("alpha\nalpha beta\n");
  });

  it("no match → exit 1", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep zzz /poem.txt");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("-i ignore case", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -i beta /poem.txt");
    expect(r.stdout).toBe("Beta\nalpha beta\n");
  });

  it("-v invert", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -v alpha /poem.txt");
    expect(r.stdout).toBe("Beta\ngamma\nDelta\n");
  });

  it("-n line numbers", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -n alpha /poem.txt");
    expect(r.stdout).toBe("1:alpha\n4:alpha beta\n");
  });

  it("-c count only", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -c alpha /poem.txt");
    expect(r.stdout).toBe("2\n");
  });

  it("-o only matched part", async () => {
    const { shell } = seeded();
    const r = await shell.exec("echo 'foo123bar456' | grep -o '[0-9]+'");
    expect(r.stdout).toBe("123\n456\n");
  });

  it("-F fixed string treats regex chars literally", async () => {
    const { shell } = sh({ "/x": "a.b\naxb\n" });
    const r = await shell.exec("grep -F a.b /x");
    expect(r.stdout).toBe("a.b\n");
  });

  it("-E extended regex (alternation)", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -E 'gamma|Delta' /poem.txt");
    expect(r.stdout).toBe("gamma\nDelta\n");
  });

  it("-r recursive over a dir, prefixes file labels", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -r foo /tree");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("/tree/a.txt:foo");
    expect(r.stdout).toContain("/tree/sub/b.txt:foo bar");
  });

  it("-l filenames with matches", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep -rl foo /tree");
    expect(r.stdout).toContain("/tree/a.txt\n");
    expect(r.stdout).toContain("/tree/sub/b.txt\n");
    expect(r.stdout).not.toContain("c.log");
  });

  it("multiple files prefix file:line", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep one /f1.txt /f2.txt");
    expect(r.stdout).toBe("/f1.txt:one\n/f2.txt:one\n");
  });

  it("single file does not prefix", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep one /f1.txt");
    expect(r.stdout).toBe("one\n");
  });

  it("bad regex → exit 2", async () => {
    const { shell } = seeded();
    const r = await shell.exec("grep '[' /poem.txt");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid regular expression");
  });
});

// ============================ sort =========================================
describe("sort", () => {
  it("lexical sort", async () => {
    const { shell } = sh({ "/x": "banana\napple\ncherry\n" });
    const r = await shell.exec("sort /x");
    expect(r.stdout).toBe("apple\nbanana\ncherry\n");
  });

  it("-n numeric", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sort -n /nums.txt");
    expect(r.stdout).toBe("1\n1\n2\n3\n10\n");
  });

  it("-r reverse", async () => {
    const { shell } = sh({ "/x": "a\nb\nc\n" });
    const r = await shell.exec("sort -r /x");
    expect(r.stdout).toBe("c\nb\na\n");
  });

  it("-u unique", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sort -u /nums.txt");
    expect(r.stdout).toBe("1\n10\n2\n3\n");
  });

  it("-n -u combined", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sort -nu /nums.txt");
    expect(r.stdout).toBe("1\n2\n3\n10\n");
  });

  it("-k field key", async () => {
    const { shell } = sh({ "/x": "z 1\na 3\nm 2\n" });
    const r = await shell.exec("sort -k 2 -n /x");
    expect(r.stdout).toBe("z 1\nm 2\na 3\n");
  });

  it("-t custom delimiter with -k", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sort -t , -k 2 -n /csv.txt");
    expect(r.stdout).toBe("ann,25\nbob,30\ncarl,40\n");
  });

  it("concatenates multiple files", async () => {
    const { shell } = sh({ "/a": "2\n", "/b": "1\n" });
    const r = await shell.exec("sort -n /a /b");
    expect(r.stdout).toBe("1\n2\n");
  });
});

// ============================ uniq =========================================
describe("uniq", () => {
  it("collapses adjacent dups", async () => {
    const { shell } = seeded();
    const r = await shell.exec("uniq /dup.txt");
    expect(r.stdout).toBe("a\nb\nc\na\n");
  });

  it("-c prefixes counts", async () => {
    const { shell } = seeded();
    const r = await shell.exec("uniq -c /dup.txt");
    expect(r.stdout).toBe(
      "      2 a\n      3 b\n      1 c\n      1 a\n",
    );
  });

  it("-d only repeated", async () => {
    const { shell } = seeded();
    const r = await shell.exec("uniq -d /dup.txt");
    expect(r.stdout).toBe("a\nb\n");
  });

  it("-u only non-repeated", async () => {
    const { shell } = seeded();
    const r = await shell.exec("uniq -u /dup.txt");
    expect(r.stdout).toBe("c\na\n");
  });

  it("-i ignore case", async () => {
    const { shell } = sh({ "/x": "Foo\nfoo\nbar\n" });
    const r = await shell.exec("uniq -i /x");
    expect(r.stdout).toBe("Foo\nbar\n");
  });
});

// ============================ tr ===========================================
describe("tr", () => {
  it("translates ranges a-z to A-Z", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo hello | tr a-z A-Z");
    expect(r.stdout).toBe("HELLO\n");
  });

  it("-d deletes set", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a1b2c3' | tr -d 0-9");
    expect(r.stdout).toBe("abc\n");
  });

  it("-s squeeze repeats", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'aaabbbccc' | tr -s abc");
    expect(r.stdout).toBe("abc\n");
  });

  it("[:upper:] / [:lower:] classes", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo HELLO | tr '[:upper:]' '[:lower:]'");
    expect(r.stdout).toBe("hello\n");
  });

  it("[:digit:] class with -d", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a1b2' | tr -d '[:digit:]'");
    expect(r.stdout).toBe("ab\n");
  });

  it("pads SET2 with last char", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo abc | tr abc x");
    expect(r.stdout).toBe("xxx\n");
  });
});

// ============================ sed ==========================================
describe("sed", () => {
  it("s///g global substitution", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a a a' | sed 's/a/b/g'");
    expect(r.stdout).toBe("b b b\n");
  });

  it("s/// first only without g", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a a a' | sed 's/a/b/'");
    expect(r.stdout).toBe("b a a\n");
  });

  it("s///i ignore case", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'Hello' | sed 's/hello/bye/i'");
    expect(r.stdout).toBe("bye\n");
  });

  it("& whole-match backref", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'cat' | sed 's/cat/[&]/'");
    expect(r.stdout).toBe("[cat]\n");
  });

  it("\\1 capture group backref", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'John Smith' | sed 's/(\\w+) (\\w+)/\\2 \\1/'");
    expect(r.stdout).toBe("Smith John\n");
  });

  it("-n with /re/p prints only matches", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sed -n '/alpha/p' /poem.txt");
    expect(r.stdout).toBe("alpha\nalpha beta\n");
  });

  it("/re/d deletes matching lines", async () => {
    const { shell } = seeded();
    const r = await shell.exec("sed '/alpha/d' /poem.txt");
    expect(r.stdout).toBe("Beta\ngamma\nDelta\n");
  });

  it("addressed s — /re/s///", async () => {
    const { shell } = sh({ "/x": "foo 1\nbar 1\nfoo 1\n" });
    const r = await shell.exec("sed '/foo/s/1/X/' /x");
    expect(r.stdout).toBe("foo X\nbar 1\nfoo X\n");
  });

  it("line-number address Nd", async () => {
    const { shell } = sh({ "/x": "a\nb\nc\n" });
    const r = await shell.exec("sed '2d' /x");
    expect(r.stdout).toBe("a\nc\n");
  });

  it("$ last-line address", async () => {
    const { shell } = sh({ "/x": "a\nb\nc\n" });
    const r = await shell.exec("sed -n '$p' /x");
    expect(r.stdout).toBe("c\n");
  });

  it("custom delimiter s|a|b|", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo /usr/bin | sed 's|/usr|/opt|'");
    expect(r.stdout).toBe("/opt/bin\n");
  });
});

// ============================ find =========================================
describe("find", () => {
  it("walks tree depth-first, parent before children", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree");
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("/tree");
    expect(lines).toContain("/tree/a.txt");
    expect(lines).toContain("/tree/sub");
    expect(lines).toContain("/tree/sub/b.txt");
    // parent before child
    expect(lines.indexOf("/tree/sub")).toBeLessThan(lines.indexOf("/tree/sub/b.txt"));
  });

  it("-name glob matches basename", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -name '*.txt'");
    expect(r.stdout).toContain("/tree/a.txt");
    expect(r.stdout).toContain("/tree/sub/b.txt");
    expect(r.stdout).not.toContain("c.log");
  });

  it("-type f only files", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -type f");
    expect(r.stdout).not.toContain("/tree\n");
    expect(r.stdout).not.toContain("/tree/sub\n");
    expect(r.stdout).toContain("/tree/a.txt");
  });

  it("-type d only dirs", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -type d");
    expect(r.stdout).toBe("/tree\n/tree/sub\n");
  });

  it("-maxdepth limits descent", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -maxdepth 1");
    expect(r.stdout).toContain("/tree/a.txt");
    expect(r.stdout).toContain("/tree/sub");
    expect(r.stdout).not.toContain("/tree/sub/b.txt");
  });

  it("-path glob matches whole path", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -path '*/sub/*'");
    expect(r.stdout).toContain("/tree/sub/b.txt");
    expect(r.stdout).toContain("/tree/sub/c.log");
    expect(r.stdout).not.toContain("/tree/a.txt");
  });

  it("missing start path → exit 1", async () => {
    const { shell } = sh();
    const r = await shell.exec("find /nope");
    expect(r.exitCode).toBe(1);
  });
});

// ============================ xargs ========================================
describe("xargs", () => {
  it("default echo joins tokens", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a b c' | xargs");
    expect(r.stdout).toBe("a b c\n");
  });

  it("runs given command with all tokens", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a b c' | xargs echo x");
    expect(r.stdout).toBe("x a b c\n");
  });

  it("-n2 batches two args per call", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a b c d' | xargs -n2 echo");
    expect(r.stdout).toBe("a b\nc d\n");
  });

  it("-n1 one per call", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'a b c' | xargs -n1 echo x");
    expect(r.stdout).toBe("x a\nx b\nx c\n");
  });

  it("-I{} substitutes per line", async () => {
    const { shell } = sh();
    const r = await shell.exec("printf 'a\\nb\\n' | xargs -I{} echo item={}");
    expect(r.stdout).toBe("item=a\nitem=b\n");
  });

  it("find ... | xargs cat", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -name '*.txt' | xargs cat");
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("foo bar");
  });
});

// ============================ diff =========================================
describe("diff", () => {
  it("identical files → exit 0, no output", async () => {
    const { shell } = sh({ "/a": "x\ny\n", "/b": "x\ny\n" });
    const r = await shell.exec("diff /a /b");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("differing files → exit 1 with change hunk", async () => {
    const { shell } = sh({ "/a": "one\ntwo\nthree\n", "/b": "one\n2\nthree\n" });
    const r = await shell.exec("diff /a /b");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("< two");
    expect(r.stdout).toContain("> 2");
    expect(r.stdout).toContain("---");
  });

  it("added lines → 'a' hunk", async () => {
    const { shell } = sh({ "/a": "one\n", "/b": "one\ntwo\n" });
    const r = await shell.exec("diff /a /b");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("> two");
  });

  it("missing file → exit 2", async () => {
    const { shell } = sh({ "/a": "x\n" });
    const r = await shell.exec("diff /a /nope");
    expect(r.exitCode).toBe(2);
  });
});

// ============================ jq ===========================================
describe("jq", () => {
  it("identity .", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo '{\"a\":1}' | jq -c .");
    expect(r.stdout).toBe('{"a":1}\n');
  });

  it(".field access", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -r .name /data.json");
    expect(r.stdout).toBe("acme\n");
  });

  it(".a.b nested access", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -r .nested.a.b /data.json");
    expect(r.stdout).toBe("deep\n");
  });

  it(".items[] iterate array (compact)", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -c '.users[]' /data.json");
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"ann"');
  });

  it(".arr[0] index", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq '.[0]' /arr.json");
    expect(r.stdout.trim()).toBe("10");
  });

  it("keys", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo '{\"b\":1,\"a\":2}' | jq -c keys");
    expect(r.stdout).toBe('["a","b"]\n');
  });

  it("length of array", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq length /arr.json");
    expect(r.stdout.trim()).toBe("3");
  });

  it("-r raw output unquotes strings", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -r '.users[].name' /data.json");
    expect(r.stdout).toBe("ann\nbob\nann\n");
  });

  it("-c compact output", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -c '.users[0]' /data.json");
    expect(r.stdout).toBe('{"name":"ann","email":"ann@x.com","age":30}\n');
  });

  it("pipe .users[] | .name", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -r '.users[] | .name' /data.json");
    expect(r.stdout).toBe("ann\nbob\nann\n");
  });

  it("map(.age)", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -c 'map(.age)' /arr.json");
    // arr.json is [10,20,30] of numbers — map identity-ish
    const r2 = await shell.exec("jq -c '.users | map(.age)' /data.json");
    expect(r2.stdout).toBe("[30,25,40]\n");
  });

  it("select(.age == 25)", async () => {
    const { shell } = seeded();
    const r = await shell.exec("jq -r '.users[] | select(.age == 25) | .name' /data.json");
    expect(r.stdout).toBe("bob\n");
  });

  it("optional .foo?", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo '{\"a\":1}' | jq -c '.b?'");
    // absent → null
    expect(r.stdout).toBe("null\n");
  });

  it("bad json → exit 2", async () => {
    const { shell } = sh();
    const r = await shell.exec("echo 'not json' | jq .");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("jq: error");
  });
});

// ============================ integration ==================================
describe("integration pipelines", () => {
  it("cat | jq -r | sort -u | wc -l", async () => {
    const { shell } = seeded();
    const r = await shell.exec("cat /data.json | jq -r '.users[].email' | sort -u | wc -l");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("3");
  });

  it("grep | sort | uniq -c", async () => {
    const { shell } = sh({ "/log": "ERROR a\nINFO b\nERROR c\nERROR a\n" });
    const r = await shell.exec("grep ERROR /log | sort | uniq -c");
    expect(r.stdout).toContain("ERROR a");
  });

  it("find | xargs grep", async () => {
    const { shell } = seeded();
    const r = await shell.exec("find /tree -name '*.txt' | xargs grep -l foo");
    expect(r.stdout).toContain("/tree/a.txt");
  });
});
