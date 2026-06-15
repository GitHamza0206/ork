import { normalizePath } from "@ork.ai/kernel";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { globToRegExp } from "../glob-match.js";
import { walkFiles } from "../walk.js";

export const grepInputSchema = z.object({
  pattern: z.string().describe("Regular expression to search for (JavaScript RegExp syntax)."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search. Defaults to cwd."),
  glob: z
    .string()
    .optional()
    .describe('Only search files whose path matches this glob, e.g. "*.ts".'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Output mode: "files_with_matches" (default) lists matching files; "content" shows matching lines; "count" shows per-file match counts.',
    ),
  case_insensitive: z.boolean().optional().describe("Case-insensitive match (like -i)."),
  line_numbers: z
    .boolean()
    .optional()
    .describe("In content mode, prefix each line with its line number (like -n)."),
  context: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("In content mode, lines of context to show before and after each match (like -C)."),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

export interface GrepResult {
  output: string;
  /** Total number of matching lines across all files. */
  matchCount: number;
  /** Files that had at least one match. */
  files: string[];
}

const DEC = new TextDecoder();

/** Split file bytes into lines, dropping a single trailing empty line. */
function toLines(bytes: Uint8Array): string[] {
  const text = DEC.decode(bytes);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Search files under `path` (default cwd) for lines matching `pattern`. Walks
 * the VFS, optionally filtering files by `glob`, and formats output per
 * `output_mode` (default "files_with_matches"). Binary files (containing NUL)
 * are skipped.
 */
export async function grepTool(input: GrepInput, ctx: ToolContext): Promise<GrepResult> {
  const root = normalizePath(input.path ?? ctx.cwd, ctx.cwd);
  const mode = input.output_mode ?? "files_with_matches";
  const flags = input.case_insensitive ? "i" : "";
  const re = new RegExp(input.pattern, flags);
  const globRe = input.glob ? globToRegExp(input.glob) : null;

  let files = await walkFiles(ctx, root);
  // Sort lexicographically so output is deterministic and agrees with Glob's
  // ordering, regardless of the VFS walk order.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (globRe) {
    files = files.filter((f) => {
      // Match the glob against the basename and the path-relative-to-root, so
      // both "*.ts" and "src/*.ts" style filters work.
      const base = f.slice(f.lastIndexOf("/") + 1);
      const rel = root === "/" ? f.slice(1) : f.startsWith(root + "/") ? f.slice(root.length + 1) : f;
      return globRe.test(base) || globRe.test(rel);
    });
  }

  const ctxLines = input.context ?? 0;
  const matchedFiles: string[] = [];
  const perFileCount = new Map<string, number>();
  const contentBlocks: string[] = [];
  let total = 0;

  for (const file of files) {
    const bytes = await ctx.sys.readFile(file);
    if (bytes.includes(0)) continue; // skip binary
    const lines = toLines(bytes);

    const matchIdx: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      // Reset lastIndex defensively (we don't use /g, but be safe).
      re.lastIndex = 0;
      if (re.test(lines[i]!)) matchIdx.push(i);
    }
    if (matchIdx.length === 0) continue;

    matchedFiles.push(file);
    perFileCount.set(file, matchIdx.length);
    total += matchIdx.length;

    if (mode === "content") {
      // Build the set of line indices to print (matches + context), merged.
      const show = new Set<number>();
      for (const m of matchIdx) {
        for (let k = m - ctxLines; k <= m + ctxLines; k++) {
          if (k >= 0 && k < lines.length) show.add(k);
        }
      }
      const sorted = [...show].sort((a, b) => a - b);
      const fileLines: string[] = [];
      for (const idx of sorted) {
        const prefix = input.line_numbers ? `${idx + 1}:` : "";
        fileLines.push(`${file}:${prefix}${lines[idx]!}`);
      }
      contentBlocks.push(fileLines.join("\n"));
    }
  }

  let output: string;
  if (mode === "files_with_matches") {
    output = matchedFiles.length > 0 ? matchedFiles.join("\n") : "No matches found";
  } else if (mode === "count") {
    output =
      matchedFiles.length > 0
        ? matchedFiles.map((f) => `${f}:${perFileCount.get(f)}`).join("\n")
        : "No matches found";
  } else {
    output = contentBlocks.length > 0 ? contentBlocks.join("\n") : "No matches found";
  }

  return { output, matchCount: total, files: matchedFiles };
}
