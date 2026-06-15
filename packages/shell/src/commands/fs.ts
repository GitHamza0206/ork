// Filesystem and text-shaped commands (agent-focused, POSIX-ish minimal):
//   ls, mkdir, rm, cp, mv, touch, head, tail, wc, printf, tee, base64, cut
// Conventions: errors go to stderr as "<cmd>: <detail>"; exit 0 ok, 1 error,
// 2 usage. Paths are resolved against ctx.cwd via ctx.resolve().

import { basename, isKernelError, readAll, readText, writeAll } from "@ork.ai/kernel";
import type { CommandContext, CommandImpl } from "../types.js";
import { parseFlags, parseOpts, parseRangeList, statOrNull, takeLines } from "./util.js";

const dec = new TextDecoder();

// ---- ls --------------------------------------------------------------------
// ls [-l] [-a] [-1] [paths...]. No path → cwd. A file path lists just its name.
// `-a` is effectively the default (readdir returns everything), but names that
// start with "." are hidden unless -a is given. `-l` long format prints a fake
// mode string + size + name: "<mode> <size>\t<name>". `-1` is one-per-line
// (also the default, since there is no tty column packing).
export const ls: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["l", "a", "1"]));
  const long = flags.has("l");
  const all = flags.has("a");
  const paths = rest.length === 0 ? ["."] : rest;
  let code = 0;
  const multiple = paths.length > 1;
  let out = "";

  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi]!;
    const abs = ctx.resolve(p);
    let st: import("@ork.ai/kernel").Stat;
    try {
      st = await ctx.sys.stat(abs);
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        await writeAll(ctx.stderr, `ls: ${p}: No such file or directory\n`);
        code = 1;
        continue;
      }
      throw err;
    }

    if (st.kind === "file") {
      out += long ? fmtLong("-", st.size, p) : p + "\n";
      continue;
    }

    // Directory.
    if (multiple) out += `${p}:\n`;
    let names = await ctx.sys.readdir(abs);
    if (!all) names = names.filter((n) => !n.startsWith("."));
    names.sort();
    for (const n of names) {
      if (long) {
        const cst = await ctx.sys.stat(abs === "/" ? `/${n}` : `${abs}/${n}`);
        out += fmtLong(cst.kind === "dir" ? "d" : "-", cst.size, n);
      } else {
        out += n + "\n";
      }
    }
    if (multiple && pi < paths.length - 1) out += "\n";
  }

  await writeAll(ctx.stdout, out);
  return code;
};

function fmtLong(type: string, size: number, name: string): string {
  const mode = type === "d" ? "drwxr-xr-x" : "-rw-r--r--";
  return `${mode} ${size}\t${name}\n`;
}

// ---- mkdir -----------------------------------------------------------------
// mkdir [-p] dir...  -p → recursive + no error if it already exists.
export const mkdir: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["p"]));
  const recursive = flags.has("p");
  if (rest.length === 0) {
    await writeAll(ctx.stderr, "mkdir: missing operand\n");
    return 2;
  }
  let code = 0;
  for (const d of rest) {
    try {
      await ctx.sys.mkdir(ctx.resolve(d), { recursive });
    } catch (err) {
      if (isKernelError(err)) {
        if (err.code === "EEXIST") {
          await writeAll(ctx.stderr, `mkdir: ${d}: File exists\n`);
        } else if (err.code === "ENOENT") {
          await writeAll(ctx.stderr, `mkdir: ${d}: No such file or directory\n`);
        } else if (err.code === "ENOTDIR") {
          await writeAll(ctx.stderr, `mkdir: ${d}: Not a directory\n`);
        } else {
          await writeAll(ctx.stderr, `mkdir: ${d}: ${err.code}\n`);
        }
        code = 1;
        continue;
      }
      throw err;
    }
  }
  return code;
};

// ---- rm --------------------------------------------------------------------
// rm [-r] [-f] path...  -r recursive dirs; -f ignore missing.
export const rm: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["r", "f", "R"]));
  const recursive = flags.has("r") || flags.has("R");
  const force = flags.has("f");
  if (rest.length === 0 && !force) {
    await writeAll(ctx.stderr, "rm: missing operand\n");
    return 2;
  }
  let code = 0;
  for (const p of rest) {
    const abs = ctx.resolve(p);
    let st: import("@ork.ai/kernel").Stat;
    try {
      st = await ctx.sys.stat(abs);
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        if (!force) {
          await writeAll(ctx.stderr, `rm: ${p}: No such file or directory\n`);
          code = 1;
        }
        continue;
      }
      throw err;
    }
    if (st.kind === "dir" && !recursive) {
      await writeAll(ctx.stderr, `rm: ${p}: Is a directory\n`);
      code = 1;
      continue;
    }
    try {
      await ctx.sys.rm(abs, { recursive });
    } catch (err) {
      if (isKernelError(err)) {
        await writeAll(ctx.stderr, `rm: ${p}: ${err.code}\n`);
        if (!force) code = 1;
        continue;
      }
      throw err;
    }
  }
  return code;
};

// ---- cp --------------------------------------------------------------------
// cp [-r] src dst. If dst is an existing dir → copy into dst/basename(src).
// -r recursive directory copy.
export const cp: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["r", "R"]));
  const recursive = flags.has("r") || flags.has("R");
  if (rest.length < 2) {
    await writeAll(ctx.stderr, "cp: missing file operand\n");
    return 2;
  }
  const [src, dst] = [rest[0]!, rest[1]!];
  const absSrc = ctx.resolve(src);
  let absDst = ctx.resolve(dst);

  let srcSt: import("@ork.ai/kernel").Stat;
  try {
    srcSt = await ctx.sys.stat(absSrc);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") {
      await writeAll(ctx.stderr, `cp: ${src}: No such file or directory\n`);
      return 1;
    }
    throw err;
  }

  // If dst is an existing directory, copy into it under the source basename.
  const dstSt = await statOrNull(ctx, absDst);
  if (dstSt?.kind === "dir") {
    absDst = absDst === "/" ? `/${basename(absSrc)}` : `${absDst}/${basename(absSrc)}`;
  }

  try {
    if (srcSt.kind === "dir") {
      if (!recursive) {
        await writeAll(ctx.stderr, `cp: ${src}: Is a directory\n`);
        return 1;
      }
      await copyDir(ctx, absSrc, absDst);
    } else {
      const data = await ctx.sys.readFile(absSrc);
      await ctx.sys.writeFile(absDst, data);
    }
  } catch (err) {
    if (isKernelError(err)) {
      await writeAll(ctx.stderr, `cp: ${dst}: ${err.code}\n`);
      return 1;
    }
    throw err;
  }
  return 0;
};

async function copyDir(ctx: CommandContext, src: string, dst: string): Promise<void> {
  await ctx.sys.mkdir(dst, { recursive: true });
  const names = await ctx.sys.readdir(src);
  for (const n of names) {
    const s = src === "/" ? `/${n}` : `${src}/${n}`;
    const d = dst === "/" ? `/${n}` : `${dst}/${n}`;
    const st = await ctx.sys.stat(s);
    if (st.kind === "dir") {
      await copyDir(ctx, s, d);
    } else {
      await ctx.sys.writeFile(d, await ctx.sys.readFile(s));
    }
  }
}

// ---- mv --------------------------------------------------------------------
// mv src dst. If dst is an existing dir → move into it under basename(src).
export const mv: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1).filter((a) => a !== "--");
  if (args.length < 2) {
    await writeAll(ctx.stderr, "mv: missing file operand\n");
    return 2;
  }
  const [src, dst] = [args[0]!, args[1]!];
  const absSrc = ctx.resolve(src);
  let absDst = ctx.resolve(dst);

  const srcSt = await statOrNull(ctx, absSrc);
  if (!srcSt) {
    await writeAll(ctx.stderr, `mv: ${src}: No such file or directory\n`);
    return 1;
  }
  const dstSt = await statOrNull(ctx, absDst);
  if (dstSt?.kind === "dir") {
    absDst = absDst === "/" ? `/${basename(absSrc)}` : `${absDst}/${basename(absSrc)}`;
  }
  try {
    await ctx.sys.rename(absSrc, absDst);
  } catch (err) {
    if (isKernelError(err)) {
      await writeAll(ctx.stderr, `mv: ${dst}: ${err.code}\n`);
      return 1;
    }
    throw err;
  }
  return 0;
};

// ---- touch -----------------------------------------------------------------
// touch path... Create an empty file if missing; if it already exists, do
// NOTHING (no truncation — we have no mtime-update syscall). Missing parent → 1.
export const touch: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1).filter((a) => a !== "--");
  if (args.length === 0) {
    await writeAll(ctx.stderr, "touch: missing file operand\n");
    return 2;
  }
  let code = 0;
  for (const p of args) {
    const abs = ctx.resolve(p);
    const st = await statOrNull(ctx, abs);
    if (st) continue; // exists → no-op
    try {
      await ctx.sys.writeFile(abs, "");
    } catch (err) {
      if (isKernelError(err)) {
        await writeAll(ctx.stderr, `touch: ${p}: No such file or directory\n`);
        code = 1;
        continue;
      }
      throw err;
    }
  }
  return code;
};

// ---- head / tail -----------------------------------------------------------
// head [-n N] [files...] / tail [-n N] [files...]. Default N=10. No files →
// stdin. Multiple files → bash-style "==> name <==" headers separated by blanks.
// Count accepts `-n N`, attached `-nN`, and the historic shorthand `-N`
// (e.g. `head -20` ≡ `head -n 20`).
function parseN(args: string[]): { n: number; files: string[]; err?: string } {
  let n = 10;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n") {
      const v = args[++i];
      if (v === undefined || !/^\d+$/.test(v)) return { n, files, err: `invalid number of lines: '${v ?? ""}'` };
      n = parseInt(v, 10);
    } else if (a.startsWith("-n") && /^-n\d+$/.test(a)) {
      n = parseInt(a.slice(2), 10); // attached: -n10
    } else if (/^-\d+$/.test(a)) {
      n = parseInt(a.slice(1), 10); // historic shorthand: head -20 ≡ -n 20
    } else if (a === "--") {
      for (let j = i + 1; j < args.length; j++) files.push(args[j]!);
      break;
    } else {
      files.push(a);
    }
  }
  return { n, files };
}

function makeHeadTail(cmd: "head" | "tail"): CommandImpl {
  return async (ctx: CommandContext) => {
    const { n, files, err } = parseN(ctx.argv.slice(1));
    if (err) {
      await writeAll(ctx.stderr, `${cmd}: ${err}\n`);
      return 2;
    }
    const tail = cmd === "tail";
    if (files.length === 0) {
      const text = await readText(ctx.stdin);
      await writeAll(ctx.stdout, takeLines(text, n, tail));
      return 0;
    }
    let code = 0;
    let out = "";
    const multiple = files.length > 1;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      let data: Uint8Array;
      try {
        data = await ctx.sys.readFile(ctx.resolve(f));
      } catch (e) {
        if (isKernelError(e) && (e.code === "ENOENT" || e.code === "EISDIR")) {
          await writeAll(
            ctx.stderr,
            `${cmd}: ${f}: ${e.code === "EISDIR" ? "Is a directory" : "No such file or directory"}\n`,
          );
          code = 1;
          continue;
        }
        throw e;
      }
      if (multiple) {
        if (out !== "") out += "\n";
        out += `==> ${f} <==\n`;
      }
      out += takeLines(dec.decode(data), n, tail);
    }
    await writeAll(ctx.stdout, out);
    return code;
  };
}

export const head = makeHeadTail("head");
export const tail = makeHeadTail("tail");

// ---- wc --------------------------------------------------------------------
// wc [-l] [-c] [-w] [files...]. No flags → lines words bytes name. stdin if no
// files. Multiple files → per-file rows + a "total" row.
export const wc: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["l", "c", "w"]));
  const anyFlag = flags.size > 0;
  const showL = !anyFlag || flags.has("l");
  const showW = !anyFlag || flags.has("w");
  const showC = !anyFlag || flags.has("c");

  const counts = (data: Uint8Array): [number, number, number] => {
    const text = dec.decode(data);
    const lines = (text.match(/\n/g) || []).length;
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    return [lines, words, data.byteLength];
  };

  const fmt = (l: number, w: number, c: number, name?: string): string => {
    const parts: string[] = [];
    if (showL) parts.push(String(l));
    if (showW) parts.push(String(w));
    if (showC) parts.push(String(c));
    return parts.join(" ") + (name ? ` ${name}` : "") + "\n";
  };

  if (rest.length === 0) {
    const [l, w, c] = counts(await readAll(ctx.stdin));
    await writeAll(ctx.stdout, fmt(l, w, c));
    return 0;
  }

  let out = "";
  let code = 0;
  let tl = 0, tw = 0, tc = 0;
  for (const f of rest) {
    let data: Uint8Array;
    try {
      data = await ctx.sys.readFile(ctx.resolve(f));
    } catch (e) {
      if (isKernelError(e) && (e.code === "ENOENT" || e.code === "EISDIR")) {
        await writeAll(
          ctx.stderr,
          `wc: ${f}: ${e.code === "EISDIR" ? "Is a directory" : "No such file or directory"}\n`,
        );
        code = 1;
        continue;
      }
      throw e;
    }
    const [l, w, c] = counts(data);
    tl += l;
    tw += w;
    tc += c;
    out += fmt(l, w, c, f);
  }
  if (rest.length > 1) out += fmt(tl, tw, tc, "total");
  await writeAll(ctx.stdout, out);
  return code;
};

// ---- printf ----------------------------------------------------------------
// printf FORMAT [args...]. Supports %s %d %% and escapes \n \t \\. The format
// is recycled over extra args (bash behaviour); missing args → "" / 0.
export const printf: CommandImpl = async (ctx) => {
  const args = ctx.argv.slice(1);
  if (args.length === 0) {
    await writeAll(ctx.stderr, "printf: usage: printf format [arguments]\n");
    return 2;
  }
  const format = args[0]!;
  const operands = args.slice(1);

  const specCount = (format.match(/%[sd]/g) || []).length;
  let out = "";
  let i = 0;
  // Run the format at least once; recycle while operands remain.
  do {
    out += applyFormat(format, operands, i);
    i += specCount;
  } while (specCount > 0 && i < operands.length);

  await writeAll(ctx.stdout, out);
  return 0;
};

function applyFormat(format: string, operands: string[], base: number): string {
  let result = "";
  let argi = base;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!;
    if (ch === "\\") {
      const next = format[++i];
      if (next === "n") result += "\n";
      else if (next === "t") result += "\t";
      else if (next === "\\") result += "\\";
      else result += next ?? "\\";
    } else if (ch === "%") {
      const next = format[++i];
      if (next === "%") {
        result += "%";
      } else if (next === "s") {
        result += operands[argi++] ?? "";
      } else if (next === "d") {
        const raw = operands[argi++];
        const n = raw === undefined || raw === "" ? 0 : parseInt(raw, 10);
        result += Number.isNaN(n) ? "0" : String(n);
      } else {
        result += "%" + (next ?? "");
      }
    } else {
      result += ch;
    }
  }
  return result;
}

// ---- tee -------------------------------------------------------------------
// tee [-a] [files...]. Copy stdin to stdout AND each file (-a appends).
export const tee: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["a"]));
  const append = flags.has("a");
  const data = await readAll(ctx.stdin);
  await writeAll(ctx.stdout, data);
  let code = 0;
  for (const f of rest) {
    const abs = ctx.resolve(f);
    try {
      if (append) {
        const existing = (await statOrNull(ctx, abs)) ? await ctx.sys.readFile(abs) : new Uint8Array();
        const merged = new Uint8Array(existing.byteLength + data.byteLength);
        merged.set(existing, 0);
        merged.set(data, existing.byteLength);
        await ctx.sys.writeFile(abs, merged);
      } else {
        await ctx.sys.writeFile(abs, data);
      }
    } catch (err) {
      if (isKernelError(err)) {
        await writeAll(ctx.stderr, `tee: ${f}: ${err.code}\n`);
        code = 1;
        continue;
      }
      throw err;
    }
  }
  return code;
};

// ---- base64 ----------------------------------------------------------------
// base64 [-d] [file]. Encode (default) or decode (-d) stdin or a single file.
export const base64Cmd: CommandImpl = async (ctx) => {
  const { flags, rest } = parseFlags(ctx.argv.slice(1), new Set(["d"]));
  const decode = flags.has("d");
  let data: Uint8Array;
  if (rest.length === 0) {
    data = await readAll(ctx.stdin);
  } else {
    try {
      data = await ctx.sys.readFile(ctx.resolve(rest[0]!));
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        await writeAll(ctx.stderr, `base64: ${rest[0]}: No such file or directory\n`);
        return 1;
      }
      throw err;
    }
  }

  try {
    if (decode) {
      const text = dec.decode(data).replace(/\s+/g, "");
      const bin = atob(text);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      await writeAll(ctx.stdout, out);
    } else {
      let bin = "";
      for (const b of data) bin += String.fromCharCode(b);
      await writeAll(ctx.stdout, btoa(bin) + "\n");
    }
  } catch {
    await writeAll(ctx.stderr, "base64: invalid input\n");
    return 1;
  }
  return 0;
};

// ---- cut -------------------------------------------------------------------
// cut -d DELIM -f LIST  |  cut -c LIST. LIST = N, "N-", "-M", "N-M" or comma
// list. Field mode splits on DELIM (default TAB); char mode slices columns.
export const cut: CommandImpl = async (ctx) => {
  const opts = parseOpts(ctx.argv.slice(1), { value: "dfc" });
  const delim = opts.values.get("d") ?? "\t";
  const fieldList: string | null = opts.values.get("f") ?? null;
  const charList: string | null = opts.values.get("c") ?? null;
  const files = opts.positional;

  if (fieldList === null && charList === null) {
    await writeAll(ctx.stderr, "cut: you must specify a list of fields or characters\n");
    return 2;
  }

  const sel = parseRangeList(fieldList ?? charList!);
  if (!sel) {
    await writeAll(ctx.stderr, "cut: invalid list\n");
    return 2;
  }

  const processLine = (line: string): string => {
    if (charList !== null) {
      const chars = [...line];
      const picked: string[] = [];
      for (let i = 1; i <= chars.length; i++) if (sel(i)) picked.push(chars[i - 1]!);
      return picked.join("");
    }
    // Field mode. A line without the delimiter is passed through whole.
    if (!line.includes(delim)) return line;
    const fields = line.split(delim);
    const picked: string[] = [];
    for (let i = 1; i <= fields.length; i++) if (sel(i)) picked.push(fields[i - 1]!);
    return picked.join(delim);
  };

  const emit = async (text: string): Promise<void> => {
    if (text === "") return;
    const hadTrailing = text.endsWith("\n");
    const body = hadTrailing ? text.slice(0, -1) : text;
    const out = body.split("\n").map(processLine).join("\n") + "\n";
    await writeAll(ctx.stdout, out);
  };

  if (files.length === 0) {
    await emit(await readText(ctx.stdin));
    return 0;
  }
  let code = 0;
  for (const f of files) {
    try {
      const data = await ctx.sys.readFile(ctx.resolve(f));
      await emit(dec.decode(data));
    } catch (e) {
      if (isKernelError(e) && (e.code === "ENOENT" || e.code === "EISDIR")) {
        await writeAll(
          ctx.stderr,
          `cut: ${f}: ${e.code === "EISDIR" ? "Is a directory" : "No such file or directory"}\n`,
        );
        code = 1;
        continue;
      }
      throw e;
    }
  }
  return code;
};

