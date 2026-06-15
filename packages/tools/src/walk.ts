import { isKernelError } from "@ork.ai/kernel";
import type { ToolContext } from "./context.js";

/**
 * Recursively walk `root` (a normalized absolute dir path) yielding every file
 * path beneath it, depth-first with directory entries sorted lexicographically.
 * Missing paths yield nothing; a file path passed as root yields just that file.
 */
export async function walkFiles(ctx: ToolContext, root: string): Promise<string[]> {
  let stat;
  try {
    stat = await ctx.sys.stat(root);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") return [];
    throw err;
  }
  if (stat.kind === "file") return [root];

  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await ctx.sys.readdir(dir);
    } catch {
      continue;
    }
    // readdir already returns sorted names; process in order, pushing dirs to
    // recurse. Push in reverse so the stack pops them in lexicographic order.
    const childDirs: string[] = [];
    for (const name of names) {
      const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
      let st;
      try {
        st = await ctx.sys.stat(full);
      } catch {
        continue;
      }
      if (st.kind === "dir") childDirs.push(full);
      else out.push(full);
    }
    for (let k = childDirs.length - 1; k >= 0; k--) stack.push(childDirs[k]!);
  }
  return out;
}
