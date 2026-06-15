import { isKernelError, normalizePath, parentOf } from "@ork.ai/kernel";
import { z } from "zod";
import type { ToolContext } from "../context.js";

export const writeInputSchema = z.object({
  file_path: z.string().describe("Path to the file to write (absolute, or relative to cwd)."),
  content: z.string().describe("Full content to write. Overwrites any existing file."),
});

export type WriteInput = z.infer<typeof writeInputSchema>;

export interface WriteResult {
  output: string;
  path: string;
  created: boolean;
}

/**
 * Write `content` to `file_path`, overwriting if it exists. Parent directories
 * are created automatically (the kernel does not auto-create them), matching
 * Claude Code's Write contract.
 */
export async function writeFileTool(input: WriteInput, ctx: ToolContext): Promise<WriteResult> {
  const path = normalizePath(input.file_path, ctx.cwd);

  // Did the file already exist? (Used only for the success message.)
  let existed = false;
  try {
    const st = await ctx.sys.stat(path);
    existed = true;
    if (st.kind === "dir") {
      throw new Error(`EISDIR: ${input.file_path} is a directory, not a file.`);
    }
  } catch (err) {
    if (!(isKernelError(err) && err.code === "ENOENT")) throw err;
  }

  // Create parent dirs if missing (recursive mkdir is a no-op if they exist).
  const parent = parentOf(path);
  if (parent !== "/") {
    try {
      await ctx.sys.stat(parent);
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        await ctx.sys.mkdir(parent, { recursive: true });
      } else {
        throw err;
      }
    }
  }

  await ctx.sys.writeFile(path, input.content);

  return {
    output: `File ${existed ? "updated" : "created"} at ${path}`,
    path,
    created: !existed,
  };
}
