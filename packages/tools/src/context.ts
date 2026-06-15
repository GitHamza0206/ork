import type { FsSyscalls } from "@ork.ai/kernel";
import type { Shell } from "@ork.ai/shell";

/**
 * Shared execution context threaded through every tool's core function.
 *
 * Core functions are plain async functions over this context so they can be
 * tested against a real kernel + shell without an LLM. The AI SDK `tool()`
 * wrappers (see {@link createTools}) are thin adapters that bind a fixed
 * context and forward the model-supplied input.
 */
export interface ToolContext {
  /** Kernel syscall table — the only way tools touch the VFS. */
  sys: FsSyscalls;
  /** Shell instance used by the Bash tool to run commands. */
  shell: Shell;
  /** Working directory used to resolve relative paths. */
  cwd: string;
}
