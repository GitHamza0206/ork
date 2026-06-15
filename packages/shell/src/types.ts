// Runtime command context handed to every CommandImpl. A command is a small
// program: it reads stdin, writes stdout/stderr, and returns an exit code. It
// resolves paths against the launching cwd via ctx.resolve() (the kernel
// syscalls themselves are cwd-agnostic), and reads the environment snapshot
// captured when the pipeline was launched.

import type { FsSyscalls } from "@ork.ai/kernel";

export interface CommandContext {
  /** argv[0] is the command name. */
  argv: string[];
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  sys: FsSyscalls;
  /** Resolved absolute working directory at launch time. */
  cwd: string;
  /** Environment snapshot (shell env + per-command prefix overlay). */
  env: ReadonlyMap<string, string>;
  /** Resolve a (possibly relative) path against cwd: normalizePath(path, cwd). */
  resolve(path: string): string;
  /** Spawn a one-off command through the registry with the current cwd/env,
   * feeding `stdin`, and collecting its output. Used by commands that need to
   * run other builtins (e.g. xargs). Bounded by the same command counter. */
  run?(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export type CommandImpl = (ctx: CommandContext) => Promise<number>;
