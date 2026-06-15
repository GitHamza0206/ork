import { normalizePath } from "@ork.ai/kernel";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { globToRegExp } from "../glob-match.js";
import { walkFiles } from "../walk.js";

export const globInputSchema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/*.json".'),
  path: z
    .string()
    .optional()
    .describe("Directory to search in. Defaults to cwd."),
});

export type GlobInput = z.infer<typeof globInputSchema>;

export interface GlobResult {
  /** Matching absolute paths. */
  matches: string[];
  /** Newline-joined matches, or "No files found". */
  output: string;
}

/** Make `full` relative to `root` (both normalized absolute paths). */
function relativeTo(root: string, full: string): string {
  if (root === "/") return full.slice(1);
  return full.slice(root.length + 1);
}

/**
 * Find files matching `pattern` under `path` (default cwd). Walks the VFS and
 * tests each file's path (relative to the search root) against the compiled
 * glob. Results are sorted by path for determinism (Claude Code sorts by mtime,
 * but VFS mtimes are coarse — see package report).
 */
export async function globTool(input: GlobInput, ctx: ToolContext): Promise<GlobResult> {
  const root = normalizePath(input.path ?? ctx.cwd, ctx.cwd);
  const re = globToRegExp(input.pattern);
  const files = await walkFiles(ctx, root);

  const matches = files.filter((f) => re.test(relativeTo(root, f))).sort();

  return {
    matches,
    output: matches.length > 0 ? matches.join("\n") : "No files found",
  };
}
