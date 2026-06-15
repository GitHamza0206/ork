// test / [ : POSIX conditional evaluator. Exit 0 = true, 1 = false, 2 = usage
// error. `[` requires a closing `]` as its final argument. Supported operators:
//   strings:  -z s, -n s, bare s, s1 = s2, s1 != s2
//   integers: n1 -eq|-ne|-lt|-le|-gt|-ge n2
//   files:    -e f, -f f, -d f, -s f   (via ctx.sys.stat on ctx.resolve(path))
//   logic:    ! expr
// No -a/-o (binary boolean) in v1 — keep it a focused evaluator.

import { isKernelError, writeAll } from "@ork.ai/kernel";
import type { CommandContext, CommandImpl } from "../types.js";

export const test: CommandImpl = async (ctx) => {
  const name = ctx.argv[0] ?? "test";
  let args = ctx.argv.slice(1);
  if (name === "[") {
    if (args[args.length - 1] !== "]") {
      await writeAll(ctx.stderr, "[: missing ']'\n");
      return 2;
    }
    args = args.slice(0, -1);
  }

  try {
    const result = await evalTest(args, ctx);
    return result ? 0 : 1;
  } catch (err) {
    if (err instanceof TestUsageError) {
      await writeAll(ctx.stderr, `${name}: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
};

class TestUsageError extends Error {}

const INT_OPS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);

async function evalTest(args: string[], ctx: CommandContext): Promise<boolean> {
  // 0 args: false. (bash: `[ ]` → false)
  if (args.length === 0) return false;

  // Leading negation.
  if (args[0] === "!") {
    return !(await evalTest(args.slice(1), ctx));
  }

  // 1 arg: true iff non-empty string.
  if (args.length === 1) {
    return args[0]!.length > 0;
  }

  // 2 args: unary operator + operand.
  if (args.length === 2) {
    const [op, operand] = args as [string, string];
    return evalUnary(op, operand, ctx);
  }

  // 3 args: binary operator.
  if (args.length === 3) {
    const [a, op, b] = args as [string, string, string];
    return evalBinary(a, op, b);
  }

  throw new TestUsageError(`too many arguments`);
}

async function evalUnary(op: string, operand: string, ctx: CommandContext): Promise<boolean> {
  switch (op) {
    case "-z":
      return operand.length === 0;
    case "-n":
      return operand.length > 0;
    case "-e":
    case "-f":
    case "-d":
    case "-s": {
      let st: import("@ork.ai/kernel").Stat | null = null;
      try {
        st = await ctx.sys.stat(ctx.resolve(operand));
      } catch (err) {
        if (isKernelError(err) && err.code === "ENOENT") return false;
        throw err;
      }
      if (op === "-e") return true;
      if (op === "-f") return st.kind === "file";
      if (op === "-d") return st.kind === "dir";
      return st.kind === "file" && st.size > 0; // -s
    }
    default:
      throw new TestUsageError(`${op}: unary operator expected`);
  }
}

function evalBinary(a: string, op: string, b: string): boolean {
  if (op === "=") return a === b;
  if (op === "!=") return a !== b;
  if (INT_OPS.has(op)) {
    const n1 = parseIntStrict(a);
    const n2 = parseIntStrict(b);
    switch (op) {
      case "-eq":
        return n1 === n2;
      case "-ne":
        return n1 !== n2;
      case "-lt":
        return n1 < n2;
      case "-le":
        return n1 <= n2;
      case "-gt":
        return n1 > n2;
      case "-ge":
        return n1 >= n2;
    }
  }
  throw new TestUsageError(`${op}: binary operator expected`);
}

function parseIntStrict(s: string): number {
  if (!/^[+-]?\d+$/.test(s.trim())) {
    throw new TestUsageError(`integer expression expected`);
  }
  return parseInt(s.trim(), 10);
}
