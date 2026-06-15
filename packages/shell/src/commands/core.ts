// Core builtins: echo, cat, pwd, true, false, : (no-op), env, date, which.
// These are the small, dependency-light commands. Filesystem-heavy commands live
// in fs.ts; the POSIX test/[ evaluator lives in test.ts.

import { isKernelError, readAll, writeAll } from "@ork.ai/kernel";
import type { CommandContext, CommandImpl } from "../types.js";

// echo: join args with single spaces + trailing newline; -n suppresses newline.
export const echo: CommandImpl = async (ctx) => {
  let args = ctx.argv.slice(1);
  let newline = true;
  if (args[0] === "-n") {
    newline = false;
    args = args.slice(1);
  }
  const out = args.join(" ") + (newline ? "\n" : "");
  await writeAll(ctx.stdout, out);
  return 0;
};

// cat: no file args copies stdin; otherwise reads each file via the syscalls.
export const cat: CommandImpl = async (ctx) => {
  const files = ctx.argv.slice(1);
  if (files.length === 0) {
    await writeAll(ctx.stdout, await readAll(ctx.stdin));
    return 0;
  }
  let code = 0;
  for (const f of files) {
    try {
      const data = await ctx.sys.readFile(ctx.resolve(f));
      await writeAll(ctx.stdout, data);
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        await writeAll(ctx.stderr, `cat: ${f}: No such file or directory\n`);
        code = 1;
      } else if (isKernelError(err) && err.code === "EISDIR") {
        await writeAll(ctx.stderr, `cat: ${f}: Is a directory\n`);
        code = 1;
      } else {
        throw err;
      }
    }
  }
  return code;
};

export const pwd: CommandImpl = async (ctx) => {
  await writeAll(ctx.stdout, ctx.cwd + "\n");
  return 0;
};

export const trueCmd: CommandImpl = async () => 0;
export const falseCmd: CommandImpl = async () => 1;

// env: print KEY=VALUE\n for each ctx.env entry, sorted by key.
export const env: CommandImpl = async (ctx) => {
  const keys = [...ctx.env.keys()].sort();
  let out = "";
  for (const k of keys) out += `${k}=${ctx.env.get(k)!}\n`;
  await writeAll(ctx.stdout, out);
  return 0;
};

// date: print ISO 8601 (UTC). A leading `+FORMAT` arg is accepted but, lacking a
// strftime engine, the format is ignored and the full ISO string is printed.
// Document: only ISO 8601 output is supported; +FORMAT is a no-op.
export const date: CommandImpl = async (ctx) => {
  const iso = new Date().toISOString();
  await writeAll(ctx.stdout, iso + "\n");
  return 0;
};

// which: this shell has no PATH; it reports registered builtins only. For each
// name, print the name on its own line if it is a known builtin; otherwise print
// nothing for that name and exit non-zero overall. Useful for agent probes that
// check whether a tool is available before invoking it.
export function makeWhich(isBuiltin: (name: string) => boolean): CommandImpl {
  return async (ctx: CommandContext) => {
    const names = ctx.argv.slice(1);
    let code = 0;
    for (const n of names) {
      if (isBuiltin(n)) {
        await writeAll(ctx.stdout, n + "\n");
      } else {
        code = 1;
      }
    }
    return code;
  };
}
