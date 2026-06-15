// Shared helpers for command implementations. Lifted from fs.ts so text.ts and
// fs.ts can reuse them instead of duplicating.

import { isKernelError } from "@ork.ai/kernel";
import type { CommandContext } from "../types.js";

/** Small flag parser: collects single-char flags from clustered/separate args
 * (e.g. `-la`, `-l -a`) until the first non-flag or `--`. Returns the flag set
 * plus the remaining operands (in order). Flags taking values are not handled
 * here — commands that need them parse explicitly. */
export function parseFlags(
  args: string[],
  known: Set<string>,
): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (a.length > 1 && a.startsWith("-")) {
      let ok = true;
      const chars = a.slice(1).split("");
      for (const c of chars) if (!known.has(c)) ok = false;
      if (ok) {
        for (const c of chars) flags.add(c);
        continue;
      }
    }
    break;
  }
  for (; i < args.length; i++) rest.push(args[i]!);
  return { flags, rest };
}

/** Spec for {@link parseOpts}: `bool` = single-char boolean flags that may be
 * clustered (`-la`); `value` = single-char flags that take a value, accepted in
 * BOTH POSIX forms — separate (`-t ,`) and attached (`-t,` / `-k2`). */
export interface OptSpec {
  bool?: string; // e.g. "rnu"
  value?: string; // e.g. "tk"
}

export interface ParsedOpts {
  flags: Set<string>; // boolean flags seen
  values: Map<string, string>; // value flag → its (last) value
  positional: string[]; // operands, in order
  error?: string; // set when a value flag is missing its argument
}

/** Shared POSIX-ish option parser. Handles clustered booleans (`-la`,
 * `-nr`), separate value flags (`-t ,`, `-n 10`), and attached value flags
 * (`-t,`, `-n10`, `-k2`). A value flag inside a cluster consumes the REST of
 * the token as its value when text follows it (`-nrk2` → n,r set, k="2"); if
 * the value flag ends the token, the next argv element is its value (`-nk 2`).
 * `--` ends option processing; everything after is positional. Unknown
 * `-x` tokens are treated as positional (commands relying on this still work).
 * Options and operands may be intermixed (so `sort file -k2` works). */
export function parseOpts(args: string[], spec: OptSpec): ParsedOpts {
  const bool = new Set((spec.bool ?? "").split(""));
  const value = new Set((spec.value ?? "").split(""));
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      for (let j = i + 1; j < args.length; j++) positional.push(args[j]!);
      break;
    }
    if (a.length < 2 || !a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    // Walk the cluster char-by-char; bail to positional if any char is unknown.
    const chars = a.slice(1);
    let valid = true;
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k]!;
      if (value.has(c)) {
        // value flag: rest of token (if any) is the value, else next argv elem.
        const attached = chars.slice(k + 1);
        if (attached !== "") {
          values.set(c, attached);
        } else {
          const v = args[++i];
          if (v === undefined) {
            return { flags, values, positional, error: c };
          }
          values.set(c, v);
        }
        break; // value flag terminates the token
      }
      if (bool.has(c)) {
        flags.add(c);
        continue;
      }
      valid = false;
      break;
    }
    if (!valid) positional.push(a);
  }
  return { flags, values, positional };
}

/** stat() returning null on ENOENT, rethrowing other kernel errors. */
export async function statOrNull(
  ctx: CommandContext,
  abs: string,
): Promise<import("@ork.ai/kernel").Stat | null> {
  try {
    return await ctx.sys.stat(abs);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Take the first/last N lines of text, normalizing the trailing newline. */
export function takeLines(text: string, n: number, tail: boolean): string {
  if (text === "") return "";
  const hadTrailing = text.endsWith("\n");
  const body = hadTrailing ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const picked = tail ? lines.slice(Math.max(0, lines.length - n)) : lines.slice(0, n);
  if (picked.length === 0) return "";
  return picked.join("\n") + "\n";
}

/** Parse a cut-style LIST into a 1-based membership predicate, or null if
 * invalid. Accepts N, "N-", "-M", "N-M" and comma-joined combinations. */
export function parseRangeList(list: string): ((i: number) => boolean) | null {
  const ranges: Array<[number, number]> = [];
  for (const part of list.split(",")) {
    if (part === "") continue;
    let m: RegExpMatchArray | null;
    if ((m = part.match(/^(\d+)$/))) {
      const n = parseInt(m[1]!, 10);
      ranges.push([n, n]);
    } else if ((m = part.match(/^(\d+)-$/))) {
      ranges.push([parseInt(m[1]!, 10), Infinity]);
    } else if ((m = part.match(/^-(\d+)$/))) {
      ranges.push([1, parseInt(m[1]!, 10)]);
    } else if ((m = part.match(/^(\d+)-(\d+)$/))) {
      ranges.push([parseInt(m[1]!, 10), parseInt(m[2]!, 10)]);
    } else {
      return null;
    }
  }
  if (ranges.length === 0) return null;
  return (i: number) => ranges.some(([lo, hi]) => i >= lo && i <= hi);
}

/** Split text into lines, dropping a single trailing newline's empty tail.
 * Returns [] for empty input. Used by text commands that operate line-wise. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const hadTrailing = text.endsWith("\n");
  const body = hadTrailing ? text.slice(0, -1) : text;
  return body.split("\n");
}
