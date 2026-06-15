import type { PermissionsConfig } from "@ork.ai/kernel";

export interface SystemPromptEnv {
  /** Working directory the agent starts in (absolute path in the virtual FS). */
  cwd: string;
  /** Mount points (rw/ro sub-trees), if any. Same shape as the kernel config. */
  mounts?: PermissionsConfig["mounts"];
  /** Network policy. When omitted/empty, the network is OFF (default). */
  network?: PermissionsConfig["network"];
}

/**
 * Build a concise, Claude-Code-like system prompt describing the ork virtual
 * environment: the in-memory filesystem, the available tools, the working
 * directory, mounts, and the network policy. Kept tight (~30-50 lines) so it
 * leaves budget for the conversation. Hosts may ignore this and pass their own
 * `system` string to {@link createSession}.
 */
export function defaultSystemPrompt(env: SystemPromptEnv): string {
  const lines: string[] = [];

  lines.push(
    "You are an autonomous coding agent operating inside ork, an in-memory virtual",
    "filesystem with a real (sandboxed) POSIX-like shell. There is no host machine,",
    "no real disk, and no UI: you act solely by calling tools.",
    "",
    "# Environment",
    `- Working directory: ${env.cwd}`,
    "- The filesystem is entirely in memory. Files you create or edit persist for the",
    "  whole session and are captured in durable snapshots — they are the durable state.",
    "- There are no symlinks. Paths are plain POSIX paths.",
  );

  const mounts = env.mounts ?? [];
  if (mounts.length > 0) {
    lines.push("- Mount points:");
    for (const m of mounts) {
      lines.push(`    ${m.path} (${m.mode === "ro" ? "read-only" : "read-write"})`);
    }
  }

  const netAllowed =
    !!env.network &&
    Array.isArray(env.network.allowedUrlPrefixes) &&
    env.network.allowedUrlPrefixes.length > 0;
  lines.push(
    netAllowed
      ? "- Network: restricted to an allow-list of URLs (curl / fetch will fail otherwise)."
      : "- Network: OFF. There is no outbound access; curl and fetch will be blocked.",
  );

  lines.push(
    "",
    "# Tools",
    "- Bash: run a shell command. Supports a practical bash subset — pipelines (|),",
    "  redirections (>, >>, 2>&1, <), && || ;, variables and $(...), globs, heredocs,",
    "  and simple if/for/while. Builtins include cat, ls, echo, grep, sed, head, tail,",
    "  wc, sort, uniq, cut, find, jq, mkdir, rm, cp, mv, touch, diff, and more.",
    "- Read: read a file with cat -n style line numbers; supports offset/limit.",
    "- Write: create or overwrite a file (parent dirs are created).",
    "- Edit: exact string replacement; old_string must be unique unless replace_all.",
    "- Glob: find files by pattern (**, *, ?, [...]), sorted by recency.",
    "- Grep: search file contents by regex, with glob filters and output modes.",
    "",
    "# Working style",
    "- Prefer the dedicated tools (Read/Write/Edit/Glob/Grep) over equivalent Bash for",
    "  file work; use Bash for pipelines and inspection.",
    "- Read a file before editing it. Verify your changes.",
    "- When a tool returns an error, read the message and correct your next call.",
    "- Keep working notes in a file (e.g. NOTES.md) so context survives compaction.",
    "- When the task is complete, stop and give a brief summary.",
  );

  return lines.join("\n");
}
