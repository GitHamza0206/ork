import { isKernelError, normalizePath } from "@ork.ai/kernel";
import { z } from "zod";
import type { ToolContext } from "../context.js";

export const editInputSchema = z.object({
  file_path: z.string().describe("Path to the file to edit (absolute, or relative to cwd)."),
  old_string: z.string().describe("Exact text to replace. Must be unique unless replace_all is set."),
  new_string: z.string().describe("Replacement text. Must differ from old_string."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence of old_string instead of requiring uniqueness."),
});

export type EditInput = z.infer<typeof editInputSchema>;

export interface EditResult {
  output: string;
  /** Number of occurrences replaced. */
  replacements: number;
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

const DEC = new TextDecoder();

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Replace `old_string` with `new_string` in a file. Errors if old_string is
 * absent, not unique (without replace_all), or identical to new_string. Returns
 * the number of replacements made.
 */
export async function editFileTool(input: EditInput, ctx: ToolContext): Promise<EditResult> {
  if (input.old_string === input.new_string) {
    throw new EditError("old_string and new_string are identical; nothing to change.");
  }

  const path = normalizePath(input.file_path, ctx.cwd);

  let bytes: Uint8Array;
  try {
    bytes = await ctx.sys.readFile(path);
  } catch (err) {
    if (isKernelError(err) && err.code === "ENOENT") {
      throw new EditError("File does not exist.");
    }
    if (isKernelError(err) && err.code === "EISDIR") {
      throw new EditError(`${input.file_path} is a directory, not a file.`);
    }
    throw err;
  }

  const text = DEC.decode(bytes);
  const occurrences = countOccurrences(text, input.old_string);

  if (occurrences === 0) {
    throw new EditError("old_string not found in file");
  }
  if (occurrences > 1 && !input.replace_all) {
    throw new EditError(
      `old_string is not unique (${occurrences} occurrences); pass replace_all or add more context`,
    );
  }

  let updated: string;
  let replacements: number;
  if (input.replace_all) {
    updated = text.split(input.old_string).join(input.new_string);
    replacements = occurrences;
  } else {
    const at = text.indexOf(input.old_string);
    updated = text.slice(0, at) + input.new_string + text.slice(at + input.old_string.length);
    replacements = 1;
  }

  await ctx.sys.writeFile(path, updated);

  return {
    output: `Made ${replacements} replacement${replacements === 1 ? "" : "s"} in ${path}`,
    replacements,
  };
}
