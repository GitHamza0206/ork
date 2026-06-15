// Text-processing commands (agent-focused subsets):
//   grep, sort, uniq, tr, sed, find, xargs, diff, jq
// Conventions: errors → stderr as "<cmd>: <detail>"; exit 0 ok/match, 1 no-match
// / not-found / differ, 2 usage / bad regex / bad json. Paths resolve via
// ctx.resolve(); stdin read via readText.

import { isKernelError, readText, writeAll } from "@ork.ai/kernel";
import type { CommandContext, CommandImpl } from "../types.js";
import { parseOpts, splitLines, statOrNull } from "./util.js";

const dec = new TextDecoder();

// Read a file's text, or report a not-found/dir error to stderr. Returns null
// on error (caller bumps exit code).
async function readFileText(
  ctx: CommandContext,
  cmd: string,
  f: string,
): Promise<string | null> {
  try {
    return dec.decode(await ctx.sys.readFile(ctx.resolve(f)));
  } catch (e) {
    if (isKernelError(e) && (e.code === "ENOENT" || e.code === "EISDIR")) {
      await writeAll(
        ctx.stderr,
        `${cmd}: ${f}: ${e.code === "EISDIR" ? "Is a directory" : "No such file or directory"}\n`,
      );
      return null;
    }
    throw e;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- grep ------------------------------------------------------------------
// grep [-i] [-v] [-n] [-c] [-r] [-l] [-E] [-F] [-o] PATTERN [files...]
// Regex match per line. By default the PATTERN is treated as a JS RegExp source
// (close enough to POSIX BRE for agent use); `-E` is identical (JS regex); `-F`
// treats PATTERN as a fixed string (regex-escaped). `-i` ignore case, `-v`
// invert, `-n` line numbers, `-c` count only, `-l` filenames-with-matches, `-o`
// print only the matched substrings (one per line), `-r` recurse into dir args.
// Output is prefixed `file:` (and `file:line:` with -n) when scanning multiple
// files or recursively. No files → stdin. Exit 0 if any match, 1 if none, 2 on
// bad regex.
export const grep: CommandImpl = async (ctx) => {
  const parsed = parseOpts(ctx.argv.slice(1), { bool: "ivncrlEFo" });
  const flags = parsed.flags;
  const operands = parsed.positional;
  if (operands.length === 0) {
    await writeAll(ctx.stderr, "grep: usage: grep [options] PATTERN [files...]\n");
    return 2;
  }
  const pattern = operands[0]!;
  const files = operands.slice(1);
  const ignoreCase = flags.has("i");
  const invert = flags.has("v");
  const number = flags.has("n");
  const countOnly = flags.has("c");
  const recursive = flags.has("r");
  const listFiles = flags.has("l");
  const fixed = flags.has("F");
  const onlyMatch = flags.has("o");

  let re: RegExp;
  try {
    const src = fixed ? escapeRegExp(pattern) : pattern;
    re = new RegExp(src, ignoreCase ? "gi" : "g");
  } catch {
    await writeAll(ctx.stderr, `grep: ${pattern}: invalid regular expression\n`);
    return 2;
  }
  const lineRe = (): RegExp => new RegExp(re.source, re.flags);

  // Expand file list: recurse into directories when -r.
  interface Src {
    label: string | null; // null = stdin (no prefix)
    text: string;
  }
  const sources: Src[] = [];
  let readError = false;

  if (files.length === 0) {
    sources.push({ label: null, text: await readText(ctx.stdin) });
  } else {
    for (const f of files) {
      const st = await statOrNull(ctx, ctx.resolve(f));
      if (st?.kind === "dir") {
        if (recursive) {
          await walkFiles(ctx, f, async (path) => {
            const t = await readFileText(ctx, "grep", path);
            if (t === null) readError = true;
            else sources.push({ label: path, text: t });
          });
        } else {
          await writeAll(ctx.stderr, `grep: ${f}: Is a directory\n`);
          readError = true;
        }
        continue;
      }
      const t = await readFileText(ctx, "grep", f);
      if (t === null) readError = true;
      else sources.push({ label: f, text: t });
    }
  }

  // Prefix file labels when scanning >1 source OR recursive.
  const withLabel = sources.filter((s) => s.label !== null).length > 1 || recursive;
  let out = "";
  let anyMatch = false;

  for (const src of sources) {
    const lines = splitLines(src.text);
    let count = 0;
    let fileMatched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const r = lineRe();
      const matched = r.test(line);
      const hit = invert ? !matched : matched;
      if (!hit) continue;
      anyMatch = true;
      fileMatched = true;
      count++;
      if (countOnly || listFiles) continue;
      const prefix = withLabel && src.label !== null ? `${src.label}:` : "";
      if (onlyMatch && !invert) {
        const mr = lineRe();
        let m: RegExpExecArray | null;
        while ((m = mr.exec(line)) !== null) {
          out += `${prefix}${number ? `${i + 1}:` : ""}${m[0]}\n`;
          if (m.index === mr.lastIndex) mr.lastIndex++;
        }
      } else {
        out += `${prefix}${number ? `${i + 1}:` : ""}${line}\n`;
      }
    }
    if (countOnly) {
      const prefix = withLabel && src.label !== null ? `${src.label}:` : "";
      out += `${prefix}${count}\n`;
    } else if (listFiles && fileMatched && src.label !== null) {
      out += `${src.label}\n`;
    }
  }

  await writeAll(ctx.stdout, out);
  if (anyMatch) return 0;
  return readError ? 2 : 1;
};

// Depth-first walk of a directory, invoking cb for each FILE path (labels built
// by joining names onto `base` as given).
async function walkFiles(
  ctx: CommandContext,
  base: string,
  cb: (path: string) => Promise<void>,
): Promise<void> {
  const abs = ctx.resolve(base);
  let names: string[];
  try {
    names = (await ctx.sys.readdir(abs)).sort();
  } catch {
    return;
  }
  for (const n of names) {
    const childLabel = base.endsWith("/") ? `${base}${n}` : `${base}/${n}`;
    const st = await statOrNull(ctx, ctx.resolve(childLabel));
    if (!st) continue;
    if (st.kind === "dir") await walkFiles(ctx, childLabel, cb);
    else await cb(childLabel);
  }
}

// ---- sort ------------------------------------------------------------------
// sort [-r] [-n] [-u] [-k N] [-t C] [files...]
// Sort lines from stdin or the concatenation of files. `-n` numeric, `-r`
// reverse, `-u` drop duplicate output lines (after sort), `-k N` sort by the
// 1-based field N (whitespace-split by default, `-t C` custom 1-char delim).
// Value flags accept BOTH POSIX forms: `-t , -k 2` and attached `-t, -k2`
// (and clusters like `-nr`). Sort is stable.
export const sort: CommandImpl = async (ctx) => {
  const opts = parseOpts(ctx.argv.slice(1), { bool: "rnu", value: "kt" });
  const numeric = opts.flags.has("n");
  const reverse = opts.flags.has("r");
  const unique = opts.flags.has("u");
  let key: number | null = null;
  if (opts.values.has("k")) {
    // `-k N[,M...]` — we honor the leading field number only.
    const raw = opts.values.get("k")!;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) {
      await writeAll(ctx.stderr, `sort: invalid key: ${raw}\n`);
      return 2;
    }
    key = n;
  }
  const delim: string | null = opts.values.get("t") ?? null;
  const files = opts.positional;

  let text: string;
  if (files.length === 0) {
    text = await readText(ctx.stdin);
  } else {
    const parts: string[] = [];
    let code = 0;
    for (const f of files) {
      const t = await readFileText(ctx, "sort", f);
      if (t === null) code = 1;
      else parts.push(t);
    }
    if (code !== 0) return code;
    text = parts.join("");
  }

  const lines = splitLines(text);
  const fieldOf = (line: string): string => {
    if (key === null) return line;
    const fields = delim !== null ? line.split(delim) : line.trim().split(/\s+/);
    return fields[key - 1] ?? "";
  };

  // Decorate-sort-undecorate for a stable comparison.
  const indexed = lines.map((line, i) => ({ line, i }));
  indexed.sort((a, b) => {
    const fa = fieldOf(a.line);
    const fb = fieldOf(b.line);
    let cmp: number;
    if (numeric) {
      const na = parseFloat(fa);
      const nb = parseFloat(fb);
      const xa = Number.isNaN(na) ? 0 : na;
      const xb = Number.isNaN(nb) ? 0 : nb;
      cmp = xa - xb;
    } else {
      cmp = fa < fb ? -1 : fa > fb ? 1 : 0;
    }
    if (cmp === 0) cmp = a.i - b.i; // stable
    return cmp;
  });

  let result = indexed.map((x) => x.line);
  if (reverse) result.reverse();
  if (unique) {
    const seen = new Set<string>();
    result = result.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  }
  await writeAll(ctx.stdout, result.length ? result.join("\n") + "\n" : "");
  return 0;
};

// ---- uniq ------------------------------------------------------------------
// uniq [-c] [-d] [-u] [-i] [file]
// Collapse ADJACENT duplicate lines. `-c` prefix the count, `-d` print only
// lines that repeated, `-u` print only lines that did not repeat, `-i` compare
// case-insensitively. stdin or a single file.
export const uniq: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  const flags = new Set<string>();
  const files: string[] = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-") && /^-[cdui]+$/.test(a)) {
      for (const c of a.slice(1)) flags.add(c);
    } else files.push(a);
  }
  const count = flags.has("c");
  const onlyDup = flags.has("d");
  const onlyUniq = flags.has("u");
  const ignoreCase = flags.has("i");

  let text: string;
  if (files.length === 0) {
    text = await readText(ctx.stdin);
  } else {
    const t = await readFileText(ctx, "uniq", files[0]!);
    if (t === null) return 1;
    text = t;
  }

  const lines = splitLines(text);
  const norm = (s: string): string => (ignoreCase ? s.toLowerCase() : s);
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i]!;
    let n = 1;
    while (i + n < lines.length && norm(lines[i + n]!) === norm(cur)) n++;
    const repeated = n > 1;
    const emit = onlyDup ? repeated : onlyUniq ? !repeated : true;
    if (emit) {
      out += count ? `${String(n).padStart(7)} ${cur}\n` : `${cur}\n`;
    }
    i += n;
  }
  await writeAll(ctx.stdout, out);
  return 0;
};

// ---- tr --------------------------------------------------------------------
// tr [-d] [-s] SET1 [SET2]
// Translate characters of SET1 to SET2 position-by-position (last char of SET2
// repeats to pad). Supports ranges (a-z) and the classes [:alpha:] [:digit:]
// [:space:] [:upper:] [:lower:]. `-d` deletes SET1 chars; `-s` squeezes runs of
// the resulting set into one. stdin only (matches bash tr). When SET2 is shorter
// than SET1, the final SET2 char repeats.
function expandSet(set: string): string {
  let out = "";
  let i = 0;
  while (i < set.length) {
    // class
    if (set[i] === "[" && set[i + 1] === ":") {
      const close = set.indexOf(":]", i + 2);
      if (close !== -1) {
        const cls = set.slice(i + 2, close);
        out += classChars(cls);
        i = close + 2;
        continue;
      }
    }
    // range a-z
    if (set[i + 1] === "-" && i + 2 < set.length) {
      const lo = set.charCodeAt(i);
      const hi = set.charCodeAt(i + 2);
      if (lo <= hi) {
        for (let c = lo; c <= hi; c++) out += String.fromCharCode(c);
        i += 3;
        continue;
      }
    }
    out += set[i];
    i++;
  }
  return out;
}

function classChars(cls: string): string {
  let out = "";
  switch (cls) {
    case "alpha":
      for (let c = 65; c <= 90; c++) out += String.fromCharCode(c);
      for (let c = 97; c <= 122; c++) out += String.fromCharCode(c);
      return out;
    case "digit":
      return "0123456789";
    case "upper":
      for (let c = 65; c <= 90; c++) out += String.fromCharCode(c);
      return out;
    case "lower":
      for (let c = 97; c <= 122; c++) out += String.fromCharCode(c);
      return out;
    case "space":
      return " \t\n\r\v\f";
    default:
      return "";
  }
}

export const tr: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  const flags = new Set<string>();
  const operands: string[] = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-") && /^-[ds]+$/.test(a)) {
      for (const c of a.slice(1)) flags.add(c);
    } else operands.push(a);
  }
  const del = flags.has("d");
  const squeeze = flags.has("s");
  if (operands.length === 0 || (!del && operands.length < 2 && !squeeze)) {
    await writeAll(ctx.stderr, "tr: usage: tr [-d] [-s] SET1 [SET2]\n");
    return 2;
  }
  const set1 = expandSet(operands[0]!);
  const set2 = operands[1] !== undefined ? expandSet(operands[1]!) : "";

  const text = await readText(ctx.stdin);
  let out = "";

  if (del) {
    const delSet = new Set(set1.split(""));
    for (const ch of text) if (!delSet.has(ch)) out += ch;
  } else if (set2 !== "") {
    const map = new Map<string, string>();
    for (let i = 0; i < set1.length; i++) {
      const to = i < set2.length ? set2[i]! : set2[set2.length - 1]!;
      map.set(set1[i]!, to);
    }
    for (const ch of text) out += map.get(ch) ?? ch;
  } else {
    out = text; // squeeze-only (set1 used as squeeze set below)
  }

  if (squeeze) {
    // Squeeze runs of characters in the squeeze set. With translation, squeeze
    // applies to SET2's chars; deletion-less squeeze-only uses SET1.
    const squeezeSet = new Set((set2 !== "" && !del ? set2 : set1).split(""));
    let sq = "";
    let prev = "";
    for (const ch of out) {
      if (squeezeSet.has(ch) && ch === prev) continue;
      sq += ch;
      prev = ch;
    }
    out = sq;
  }

  await writeAll(ctx.stdout, out);
  return 0;
};

// ---- sed -------------------------------------------------------------------
// sed [-n] [-E] SCRIPT [files...]   (or repeated -e SCRIPT)
// Supported subset (per-line, in order):
//   s/re/repl/[gi]   substitution. The delimiter is the char right after `s`
//                    (/ or any other char). `repl` supports & = whole match and
//                    \1..\9 = capture groups. `g` = global, `i` = ignore-case.
//   [addr]p          print the line (with -n, only addressed/explicit prints).
//   [addr]d          delete (suppress) the line.
//   [addr]s/...      addressed substitution.
// Addresses: N (line number), $ (last line), /regex/.
// UNSUPPORTED (documented): hold space, y///, line ranges N,M, branching,
// a/i/c, multiple semicolon-joined commands in one script string.
interface SedCmd {
  addr: { kind: "line"; n: number } | { kind: "last" } | { kind: "re"; re: RegExp } | null;
  op: "s" | "p" | "d";
  // for s:
  re?: RegExp;
  repl?: string;
  global?: boolean;
}

function parseSedScript(script: string, extended: boolean): SedCmd | string {
  let s = script.trim();
  let addr: SedCmd["addr"] = null;
  // address
  if (s[0] === "/") {
    const end = findUnescaped(s, 1, "/");
    if (end === -1) return "unterminated address regex";
    const src = s.slice(1, end);
    try {
      addr = { kind: "re", re: new RegExp(src) };
    } catch {
      return "invalid address regex";
    }
    s = s.slice(end + 1).trim();
  } else if (s[0] === "$") {
    addr = { kind: "last" };
    s = s.slice(1).trim();
  } else {
    const m = s.match(/^(\d+)/);
    if (m) {
      addr = { kind: "line", n: parseInt(m[1]!, 10) };
      s = s.slice(m[1]!.length).trim();
    }
  }

  const op = s[0];
  if (op === "p") return { addr, op: "p" };
  if (op === "d") return { addr, op: "d" };
  if (op === "s") {
    const delim = s[1];
    if (!delim) return "unterminated s command";
    const reEnd = findUnescaped(s, 2, delim);
    if (reEnd === -1) return "unterminated s command";
    const replEnd = findUnescaped(s, reEnd + 1, delim);
    if (replEnd === -1) return "unterminated s command";
    const rawRe = s.slice(2, reEnd);
    const repl = s.slice(reEnd + 1, replEnd);
    const flagStr = s.slice(replEnd + 1);
    const global = flagStr.includes("g");
    const ic = flagStr.includes("i");
    let reFlags = global ? "g" : "";
    if (ic) reFlags += "i";
    // `extended`/-E doesn't change JS regex semantics here; both treat the
    // pattern as a JS RegExp source. Documented as such.
    void extended;
    let re: RegExp;
    try {
      re = new RegExp(rawRe, reFlags || (global ? "g" : ""));
    } catch {
      return "invalid regex in s command";
    }
    if (!re.flags.includes("g")) re = new RegExp(re.source, re.flags + "g");
    return { addr, op: "s", re, repl, global };
  }
  return `unknown command: ${op ?? ""}`;
}

// Find the next occurrence of `ch` in `s` at or after `from`, skipping
// backslash-escaped instances.
function findUnescaped(s: string, from: number, ch: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === ch) return i;
  }
  return -1;
}

// Apply an s/// replacement honoring & (whole match), \1..\9 (groups), and
// \& / \\ escapes. When not global, only the first match is replaced.
function applySub(line: string, re: RegExp, repl: string, global: boolean): string {
  const doRepl = (m: RegExpMatchArray): string => {
    let out = "";
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i]!;
      if (c === "\\") {
        const next = repl[++i];
        if (next === undefined) out += "\\";
        else if (next === "&") out += "&";
        else if (next === "\\") out += "\\";
        else if (next === "n") out += "\n";
        else if (/[1-9]/.test(next)) out += m[parseInt(next, 10)] ?? "";
        else out += next;
      } else if (c === "&") {
        out += m[0];
      } else {
        out += c;
      }
    }
    return out;
  };

  if (global) {
    return line.replace(re, (...rawArgs: unknown[]) => {
      // String.replace passes: match, p1, p2, ..., offset, string, [groups].
      // Trim trailing offset(number)+string(string)[+groups(object)].
      let endTrim = rawArgs.length;
      // last arg may be a named-groups object
      if (endTrim > 0 && typeof rawArgs[endTrim - 1] === "object") endTrim--;
      // then string, then offset
      endTrim -= 2;
      const m = rawArgs.slice(0, endTrim) as string[];
      return doRepl(m as unknown as RegExpMatchArray);
    });
  }
  const single = new RegExp(re.source, re.flags.replace("g", ""));
  const m = single.exec(line);
  if (!m) return line;
  return line.slice(0, m.index) + doRepl(m) + line.slice(m.index + m[0].length);
}

export const sed: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  let suppress = false;
  let extended = false;
  const scripts: string[] = [];
  const files: string[] = [];
  let scriptTaken = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n") suppress = true;
    else if (a === "-E" || a === "-r") extended = true;
    else if (a === "-e") {
      const v = args[++i];
      if (v !== undefined) {
        scripts.push(v);
        scriptTaken = true;
      }
    } else if (a.startsWith("-e") && a.length > 2) {
      // attached form: -e's/a/b/'
      scripts.push(a.slice(2));
      scriptTaken = true;
    } else if (a.length > 1 && a.startsWith("-") && /^-[nEr]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "n") suppress = true;
        else extended = true;
      }
    } else if (!scriptTaken && scripts.length === 0) {
      scripts.push(a);
      scriptTaken = true;
    } else {
      files.push(a);
    }
  }
  if (scripts.length === 0) {
    await writeAll(ctx.stderr, "sed: no script specified\n");
    return 2;
  }
  const cmds: SedCmd[] = [];
  for (const sc of scripts) {
    const parsed = parseSedScript(sc, extended);
    if (typeof parsed === "string") {
      await writeAll(ctx.stderr, `sed: ${parsed}\n`);
      return 2;
    }
    cmds.push(parsed);
  }

  let text: string;
  let code = 0;
  if (files.length === 0) {
    text = await readText(ctx.stdin);
  } else {
    const parts: string[] = [];
    for (const f of files) {
      const t = await readFileText(ctx, "sed", f);
      if (t === null) code = 2;
      else parts.push(t);
    }
    text = parts.join("");
  }

  const lines = splitLines(text);
  const matchAddr = (cmd: SedCmd, line: string, idx: number, total: number): boolean => {
    if (cmd.addr === null) return true;
    if (cmd.addr.kind === "line") return idx + 1 === cmd.addr.n;
    if (cmd.addr.kind === "last") return idx === total - 1;
    return cmd.addr.re.test(line);
  };

  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    let deleted = false;
    let explicitPrints = "";
    for (const cmd of cmds) {
      const hit = matchAddr(cmd, line, i, lines.length);
      if (cmd.op === "s") {
        if (hit) line = applySub(line, cmd.re!, cmd.repl!, cmd.global ?? false);
      } else if (cmd.op === "d") {
        if (hit) {
          deleted = true;
          break;
        }
      } else if (cmd.op === "p") {
        if (hit) explicitPrints += line + "\n";
      }
    }
    if (deleted) continue;
    out += explicitPrints;
    if (!suppress) out += line + "\n";
  }
  await writeAll(ctx.stdout, out);
  return code;
};

// ---- find ------------------------------------------------------------------
// find [path] [-name GLOB] [-type f|d] [-maxdepth N] [-path GLOB]
// Walk the VFS from `path` (default cwd as "."), printing matching paths
// depth-first (parent before children). `-name` matches the basename via
// fnmatch (* ? []); `-type f|d` filters; `-maxdepth N` limits depth (0 = the
// start path only); `-path GLOB` matches the whole printed path. No other
// predicates are supported.
function fnmatchToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (glob[j] === "!") {
        cls += "^";
        j++;
      }
      while (j < glob.length && glob[j] !== "]") {
        cls += glob[j] === "\\" ? "\\\\" : glob[j];
        j++;
      }
      cls += "]";
      re += cls;
      i = j;
    } else re += escapeRegExp(c);
  }
  return new RegExp(re + "$");
}

// Like fnmatch but * also matches "/" (for -path matching whole paths).
function pathGlobToRegExp(glob: string): RegExp {
  let re = "^";
  for (const c of glob) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else re += escapeRegExp(c);
  }
  return new RegExp(re + "$");
}

export const find: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  let start = ".";
  let nameRe: RegExp | null = null;
  let pathRe: RegExp | null = null;
  let typeFilter: "f" | "d" | null = null;
  let maxdepth = Infinity;
  let i = 0;
  // Leading non-flag operand is the start path.
  if (args[0] !== undefined && !args[0].startsWith("-")) {
    start = args[0];
    i = 1;
  }
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-name") nameRe = fnmatchToRegExp(args[++i] ?? "");
    else if (a === "-path") pathRe = pathGlobToRegExp(args[++i] ?? "");
    else if (a === "-type") {
      const t = args[++i];
      if (t === "f" || t === "d") typeFilter = t;
      else {
        await writeAll(ctx.stderr, `find: -type: unknown type ${t ?? ""}\n`);
        return 2;
      }
    } else if (a === "-maxdepth") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isNaN(n)) {
        await writeAll(ctx.stderr, "find: -maxdepth: invalid argument\n");
        return 2;
      }
      maxdepth = n;
    } else {
      await writeAll(ctx.stderr, `find: unknown predicate: ${a}\n`);
      return 2;
    }
  }

  const startAbs = ctx.resolve(start);
  const startSt = await statOrNull(ctx, startAbs);
  if (!startSt) {
    await writeAll(ctx.stderr, `find: ${start}: No such file or directory\n`);
    return 1;
  }

  let out = "";
  const baseName = (p: string): string => {
    const parts = p.split("/").filter((x) => x !== "");
    return parts.length ? parts[parts.length - 1]! : p;
  };
  const emit = (label: string, kind: "file" | "dir"): void => {
    if (typeFilter === "f" && kind !== "file") return;
    if (typeFilter === "d" && kind !== "dir") return;
    if (nameRe && !nameRe.test(baseName(label))) return;
    if (pathRe && !pathRe.test(label)) return;
    out += label + "\n";
  };

  const walk = async (label: string, abs: string, kind: "file" | "dir", depth: number) => {
    emit(label, kind);
    if (kind !== "dir" || depth >= maxdepth) return;
    let names: string[];
    try {
      names = (await ctx.sys.readdir(abs)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const childLabel = label === "/" ? `/${n}` : label.endsWith("/") ? `${label}${n}` : `${label}/${n}`;
      const childAbs = abs === "/" ? `/${n}` : `${abs}/${n}`;
      const st = await statOrNull(ctx, childAbs);
      if (!st) continue;
      await walk(childLabel, childAbs, st.kind, depth + 1);
    }
  };

  await walk(start, startAbs, startSt.kind, 0);
  await writeAll(ctx.stdout, out);
  return 0;
};

// ---- xargs -----------------------------------------------------------------
// xargs [-n N] [-I REPL] [cmd [args...]]
// Read stdin, split into tokens on whitespace, and build command invocations.
// Default command is `echo`. `-n N` passes N tokens per invocation. `-I REPL`
// substitutes REPL in the arg template with each input LINE (implies -n 1 and
// line-based splitting). Runs each invocation via ctx.run (a one-off proc
// through the registry). Exit code is the last non-zero invocation code, else 0.
export const xargs: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  let perCall: number | null = null;
  let replace: string | null = null;
  const cmd: string[] = [];
  let collecting = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!collecting && a === "-n") {
      perCall = parseInt(args[++i] ?? "", 10);
      if (Number.isNaN(perCall)) {
        await writeAll(ctx.stderr, "xargs: -n: invalid number\n");
        return 2;
      }
    } else if (!collecting && /^-n\d+$/.test(a)) {
      perCall = parseInt(a.slice(2), 10);
    } else if (!collecting && a === "-I") {
      replace = args[++i] ?? null;
    } else if (!collecting && a.startsWith("-I") && a.length > 2) {
      replace = a.slice(2);
    } else {
      collecting = true;
      cmd.push(a);
    }
  }
  const base = cmd.length > 0 ? cmd : ["echo"];

  if (!ctx.run) {
    await writeAll(ctx.stderr, "xargs: command execution unavailable\n");
    return 2;
  }

  const input = await readText(ctx.stdin);
  let exitCode = 0;
  const invocations: string[][] = [];

  if (replace !== null) {
    // line-based; substitute REPL token in template per input line.
    const lines = splitLines(input).filter((l) => l.trim() !== "");
    for (const line of lines) {
      const argv = base.map((tok) => (tok === replace ? line : tok.split(replace).join(line)));
      invocations.push(argv);
    }
  } else {
    const tokens = input.split(/\s+/).filter((t) => t !== "");
    if (tokens.length === 0) {
      // GNU xargs runs the command once with no args unless -r; we mimic that.
      invocations.push([...base]);
    } else {
      const n = perCall ?? tokens.length;
      for (let i = 0; i < tokens.length; i += n) {
        invocations.push([...base, ...tokens.slice(i, i + n)]);
      }
    }
  }

  let out = "";
  let err = "";
  for (const argv of invocations) {
    const res = await ctx.run(argv, "");
    out += res.stdout;
    err += res.stderr;
    if (res.exitCode !== 0) exitCode = res.exitCode;
  }
  await writeAll(ctx.stdout, out);
  if (err) await writeAll(ctx.stderr, err);
  return exitCode;
};

// ---- diff ------------------------------------------------------------------
// diff FILE1 FILE2
// Line-based diff in normal `diff` format using an LCS. Emits `Na`, `Nd`, `Nc`
// hunk headers with `< ` (file1) and `> ` (file2) lines and a `---` separator
// for changes. Exit 0 identical, 1 differ, 2 error (e.g. missing file).
export const diff: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1).filter((a) => a !== "--");
  if (args.length < 2) {
    await writeAll(ctx.stderr, "diff: missing operand\n");
    return 2;
  }
  const a = await readFileText(ctx, "diff", args[0]!);
  const b = await readFileText(ctx, "diff", args[1]!);
  if (a === null || b === null) return 2;
  if (a === b) return 0;

  const la = splitLines(a);
  const lb = splitLines(b);

  // LCS table.
  const m = la.length;
  const n = lb.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = la[i] === lb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Build hunks of (delete-range, add-range).
  interface Hunk {
    aStart: number;
    aEnd: number;
    bStart: number;
    bEnd: number;
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (la[i] === lb[j]) {
      i++;
      j++;
      continue;
    }
    const aStart = i;
    const bStart = j;
    // Advance per LCS to the next common point.
    while (i < m && j < n && la[i] !== lb[j]) {
      if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
      else j++;
    }
    hunks.push({ aStart, aEnd: i, bStart, bEnd: j });
  }
  if (i < m || j < n) {
    hunks.push({ aStart: i, aEnd: m, bStart: j, bEnd: n });
  }

  let out = "";
  for (const h of hunks) {
    const aCount = h.aEnd - h.aStart;
    const bCount = h.bEnd - h.bStart;
    const aRange = aCount === 0 ? `${h.aStart}` : aCount === 1 ? `${h.aStart + 1}` : `${h.aStart + 1},${h.aEnd}`;
    const bRange = bCount === 0 ? `${h.bStart}` : bCount === 1 ? `${h.bStart + 1}` : `${h.bStart + 1},${h.bEnd}`;
    if (aCount === 0) {
      out += `${aRange}a${bRange}\n`;
      for (let k = h.bStart; k < h.bEnd; k++) out += `> ${lb[k]}\n`;
    } else if (bCount === 0) {
      out += `${aRange}d${bRange}\n`;
      for (let k = h.aStart; k < h.aEnd; k++) out += `< ${la[k]}\n`;
    } else {
      out += `${aRange}c${bRange}\n`;
      for (let k = h.aStart; k < h.aEnd; k++) out += `< ${la[k]}\n`;
      out += `---\n`;
      for (let k = h.bStart; k < h.bEnd; k++) out += `> ${lb[k]}\n`;
    }
  }
  await writeAll(ctx.stdout, out);
  return 1;
};

// ---- jq --------------------------------------------------------------------
// jq [-r] [-c] FILTER [file]
// A useful subset of jq over JSON from stdin or a file. Supported grammar:
//   .                 identity
//   .foo .foo.bar     field access (chained)
//   .foo?             optional field (null instead of error if absent / wrong type)
//   .[0] .[i]         array index
//   .[]               iterate array elements OR object values
//   .foo[]            field then iterate
//   |                 pipe (left output feeds right filter, per-value)
//   keys              sorted keys of an object (or indices of an array)
//   values            values of an object / elements of an array
//   length            length of array/string/object, or 0 for null
//   map(f)            apply f to each element of an array, collect results
//   select(EXPR)      keep input iff EXPR is truthy; EXPR = `.path == LITERAL`
//                     (== and != with a string/number/true/false/null literal)
//   literals          "str", numbers, true, false, null (as standalone filters)
// Flags: -r raw (strings printed unquoted), -c compact (one line per value).
// UNSUPPORTED (documented): arithmetic, multiple comparisons, recursive ..,
// object construction {}, array construction [...], functions beyond the above,
// slices .[a:b], string interpolation, alternative //, env, $vars.
type JsonVal = unknown;

class JqError extends Error {}

// Tokenize+evaluate a filter against an input value, yielding zero or more
// output values (jq filters are streaming).
function jqEval(filter: string, input: JsonVal): JsonVal[] {
  const f = filter.trim();
  // pipe (top-level | not inside parens/brackets/strings)
  const pipeIdx = topLevelSplit(f, "|");
  if (pipeIdx.length > 1) {
    let vals: JsonVal[] = [input];
    for (const part of pipeIdx) {
      const next: JsonVal[] = [];
      for (const v of vals) next.push(...jqEval(part, v));
      vals = next;
    }
    return vals;
  }
  return jqEvalAtom(f, input);
}

// Split `s` on top-level occurrences of `sep` (a single char), respecting
// quotes and (), [], {} nesting. Returns the pieces (length 1 if no split).
function topLevelSplit(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === "\\") {
        cur += s[++i] ?? "";
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth === 0 && c === sep) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function jqEvalAtom(f: string, input: JsonVal): JsonVal[] {
  const s = f.trim();
  if (s === "" || s === ".") return [input];

  // literals
  if (s === "true") return [true];
  if (s === "false") return [false];
  if (s === "null") return [null];
  if (/^-?\d+(\.\d+)?$/.test(s)) return [Number(s)];
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return [JSON.parse(s)];
    } catch {
      throw new JqError("invalid string literal");
    }
  }

  // keys / values / length
  if (s === "keys") {
    if (Array.isArray(input)) return [input.map((_, i) => i)];
    if (input && typeof input === "object") return [Object.keys(input).sort()];
    throw new JqError("keys: input must be an object or array");
  }
  if (s === "values") {
    if (Array.isArray(input)) return [input];
    if (input && typeof input === "object") return [Object.values(input)];
    throw new JqError("values: input must be an object or array");
  }
  if (s === "length") {
    if (input === null) return [0];
    if (typeof input === "string" || Array.isArray(input)) return [(input as string | unknown[]).length];
    if (typeof input === "object") return [Object.keys(input).length];
    if (typeof input === "number") return [Math.abs(input)];
    throw new JqError("length: bad input");
  }

  // map(f)
  let mm: RegExpMatchArray | null;
  if ((mm = s.match(/^map\((.*)\)$/s))) {
    if (!Array.isArray(input)) throw new JqError("map: input must be an array");
    const inner = mm[1]!;
    const out: JsonVal[] = [];
    for (const el of input) out.push(...jqEval(inner, el));
    return [out];
  }

  // select(EXPR)
  if ((mm = s.match(/^select\((.*)\)$/s))) {
    return jqSelect(mm[1]!, input) ? [input] : [];
  }

  // path expression starting with `.`
  if (s.startsWith(".")) return jqPath(s, input);

  throw new JqError(`unsupported filter: ${s}`);
}

// Evaluate a select() predicate of the form `PATH == LITERAL` or `PATH != LITERAL`,
// or a bare PATH (truthy test).
function jqSelect(expr: string, input: JsonVal): boolean {
  const e = expr.trim();
  const m = e.match(/^(.*?)(==|!=)(.*)$/s);
  if (!m) {
    const vals = jqEval(e, input);
    return vals.some((v) => v !== null && v !== false && v !== undefined);
  }
  const lhs = jqEval(m[1]!.trim(), input);
  const rhsStr = m[3]!.trim();
  let rhs: JsonVal;
  try {
    rhs = parseJqLiteral(rhsStr);
  } catch {
    throw new JqError(`select: bad literal ${rhsStr}`);
  }
  const eq = lhs.some((v) => JSON.stringify(v) === JSON.stringify(rhs));
  return m[2] === "==" ? eq : !eq;
}

function parseJqLiteral(s: string): JsonVal {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  return JSON.parse(s);
}

// Evaluate a `.`-rooted path expression: a sequence of `.field`, `.field?`,
// `[i]`, `[]`. Returns the resulting value stream.
function jqPath(s: string, input: JsonVal): JsonVal[] {
  let vals: JsonVal[] = [input];
  let i = 0; // points at the leading "."
  while (i < s.length) {
    const c = s[i]!;
    if (c === ".") {
      // could be ".[...]" or ".field" or bare "." (handled by caller)
      if (s[i + 1] === "[" || s[i + 1] === undefined) {
        i++;
        continue;
      }
      // read field name
      let j = i + 1;
      let name = "";
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) {
        name += s[j]!;
        j++;
      }
      const optional = s[j] === "?";
      if (optional) j++;
      const next: JsonVal[] = [];
      for (const v of vals) {
        if (v === null || v === undefined) {
          if (optional) continue;
          next.push(null);
          continue;
        }
        if (typeof v !== "object" || Array.isArray(v)) {
          if (optional) continue;
          throw new JqError(`cannot index ${typeof v} with "${name}"`);
        }
        const got = (v as Record<string, unknown>)[name];
        next.push(got === undefined ? null : got);
      }
      vals = next;
      i = j;
      continue;
    }
    if (c === "[") {
      const close = s.indexOf("]", i);
      if (close === -1) throw new JqError("unterminated [");
      const idxStr = s.slice(i + 1, close).trim();
      const next: JsonVal[] = [];
      if (idxStr === "") {
        // iterate
        for (const v of vals) {
          if (Array.isArray(v)) next.push(...v);
          else if (v && typeof v === "object") next.push(...Object.values(v));
          else throw new JqError("cannot iterate over non-array/object");
        }
      } else {
        const idx = parseInt(idxStr, 10);
        if (Number.isNaN(idx)) throw new JqError(`bad index ${idxStr}`);
        for (const v of vals) {
          if (!Array.isArray(v)) {
            next.push(null);
            continue;
          }
          const realIdx = idx < 0 ? v.length + idx : idx;
          next.push(realIdx >= 0 && realIdx < v.length ? v[realIdx] : null);
        }
      }
      vals = next;
      i = close + 1;
      continue;
    }
    if (c === "?") {
      i++;
      continue;
    }
    throw new JqError(`unexpected char '${c}' in path`);
  }
  return vals;
}

export const jq: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  let raw = false;
  let compact = false;
  let filter: string | null = null;
  const files: string[] = [];
  for (const a of args) {
    if (a.length > 1 && a.startsWith("-") && /^-[rc]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "r") raw = true;
        else compact = true;
      }
    } else if (filter === null) {
      filter = a;
    } else {
      files.push(a);
    }
  }
  if (filter === null) {
    await writeAll(ctx.stderr, "jq: usage: jq [-r] [-c] FILTER [file]\n");
    return 2;
  }

  let text: string;
  if (files.length === 0) {
    text = await readText(ctx.stdin);
  } else {
    const t = await readFileText(ctx, "jq", files[0]!);
    if (t === null) return 2;
    text = t;
  }

  let data: JsonVal;
  try {
    data = JSON.parse(text);
  } catch {
    await writeAll(ctx.stderr, "jq: error: invalid JSON\n");
    return 2;
  }

  let results: JsonVal[];
  try {
    results = jqEval(filter, data);
  } catch (e) {
    const msg = e instanceof JqError ? e.message : String(e);
    await writeAll(ctx.stderr, `jq: error: ${msg}\n`);
    return 2;
  }

  let out = "";
  for (const v of results) {
    if (raw && typeof v === "string") {
      out += v + "\n";
    } else {
      out += (compact ? JSON.stringify(v) : JSON.stringify(v, null, 2)) + "\n";
    }
  }
  await writeAll(ctx.stdout, out);
  return 0;
};
