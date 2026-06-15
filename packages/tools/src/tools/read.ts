import { isKernelError, normalizePath } from "@ork.ai/kernel";
import { z } from "zod";
import type { ToolContext } from "../context.js";

export const readInputSchema = z.object({
  file_path: z.string().describe("Path to the file to read (absolute, or relative to cwd)."),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from. Defaults to 1."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of lines to read. Defaults to 2000."),
});

export type ReadInput = z.infer<typeof readInputSchema>;

export interface ReadResult {
  /** Text to return to the model (cat -n style, or a status note). */
  output: string;
  /** Set when the read could not produce file content (missing/dir/binary/empty). */
  note?: "missing" | "directory" | "binary" | "empty";
}

const DEFAULT_LIMIT = 2000;
const DEC = new TextDecoder();

/** Right-align a line number in a 6-wide field, like `cat -n`. */
function lineNumber(n: number): string {
  return String(n).padStart(6, " ");
}

/**
 * Read a file and format it `cat -n` style: a 6-wide right-aligned line number,
 * a tab, then the line content. Honors `offset` (1-based) and `limit`.
 */
export async function readFileTool(input: ReadInput, ctx: ToolContext): Promise<ReadResult> {
  const path = normalizePath(input.file_path, ctx.cwd);

  let stat;
  try {
    stat = await ctx.sys.stat(path);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") {
      return { output: "File does not exist.", note: "missing" };
    }
    throw err;
  }

  if (stat.kind === "dir") {
    return { output: `EISDIR: ${input.file_path} is a directory, not a file.`, note: "directory" };
  }

  const bytes = await ctx.sys.readFile(path);

  // Binary detection: any NUL byte means we will not render the content.
  if (bytes.includes(0)) {
    return { output: "[binary file]", note: "binary" };
  }

  if (bytes.byteLength === 0) {
    return {
      output: "<system-reminder>File is empty.</system-reminder>",
      note: "empty",
    };
  }

  const text = DEC.decode(bytes);
  // Split into lines without a trailing empty element when the file ends in \n.
  const allLines = text.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();

  const offset = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const start = offset - 1;
  const slice = allLines.slice(start, start + limit);

  const rendered = slice
    .map((line, i) => `${lineNumber(offset + i)}\t${line}`)
    .join("\n");

  return { output: rendered };
}
