import { createKernel, type Kernel } from "@ork.ai/kernel";
import { Shell } from "@ork.ai/shell";
import type { ToolContext } from "../src/context.js";

export function makeCtx(
  files: Record<string, string | Uint8Array> = {},
  cwd = "/",
): { ctx: ToolContext; kernel: Kernel; shell: Shell } {
  const kernel = createKernel({ files });
  const shell = new Shell(kernel, { cwd });
  const ctx: ToolContext = { sys: kernel.sys, shell, cwd };
  return { ctx, kernel, shell };
}

const DEC = new TextDecoder();

/** Read a file back through the kernel as text (test assertion helper). */
export async function readBack(kernel: Kernel, path: string): Promise<string> {
  return DEC.decode(await kernel.sys.readFile(path));
}
