import {
  createKernel,
  restoreKernel,
  KernelError,
  type Kernel,
  type KernelOptions,
  type SnapshotStore,
  type PermissionsConfig,
  type Limits,
  type Workspace,
} from "@ork.ai/kernel";
import { Shell } from "@ork.ai/shell";
import { createTools } from "@ork.ai/tools";
import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { defaultSystemPrompt } from "./system-prompt.js";
import { compact } from "./compaction.js";
import type { SessionEvent } from "./events.js";

const DEFAULT_MAX_STEPS = 50;

export interface SessionConfig {
  /** "provider/model" routed via the AI Gateway, OR a LanguageModelV2 instance. */
  model: LanguageModel;
  /** Initial files seeded into the virtual FS. */
  files?: Record<string, string | Uint8Array>;
  /** Override the system prompt. Defaults to {@link defaultSystemPrompt}. */
  system?: string;
  /** Working directory (default "/"). */
  cwd?: string;
  mounts?: PermissionsConfig["mounts"];
  network?: PermissionsConfig["network"];
  limits?: Partial<Limits>;
  /** Tool-loop step cap (default 50). */
  maxSteps?: number;
  /**
   * Approximate token budget. When set, the conversation is compacted before
   * each turn once its estimated size exceeds the budget (chars/4 heuristic).
   * When unset, no compaction is applied. See {@link compact}.
   */
  tokenBudget?: number;
  /** Override the fetch implementation (forwarded to the kernel for `curl`). */
  fetchImpl?: typeof fetch;
  /**
   * Workspace externe (FS partagé, géré par Workspace.open/commit). Mutuellement
   * exclusif avec `files`. La config kernel (mounts/network/limits/fetchImpl)
   * de cette SessionConfig est ignorée : elle a été fixée à Workspace.open.
   * Persistance : utiliser `workspace.commit()` (FS-only + avance du pointeur) —
   * PAS `session.snapshot()`, qui écrit un snapshot couplé FS+messages sans
   * jamais avancer le pointeur du workspace.
   */
  workspace?: Workspace;
  /**
   * Historique initial de la conversation (thread géré par l'hôte). La session
   * démarre avec ces messages et les fait croître ; à l'hôte de re-sauvegarder
   * `session.messages` après le tour.
   */
  messages?: ModelMessage[];
}

/** Options for a single {@link Session.send} turn. */
export interface SendOptions {
  /**
   * Abort the turn (e.g. the HTTP client disconnected mid-SSE). The signal is
   * forwarded to the AI SDK's `streamText({ abortSignal })`, which stops the
   * model call and tool loop — no further model spend. The turn then emits a
   * final `{ type: "error", message: "aborted" }` event and the iterator
   * completes cleanly (never throws).
   */
  signal?: AbortSignal;
}

export interface Session {
  /** Run one turn; yields a stream of {@link SessionEvent}. */
  send(prompt: string, opts?: SendOptions): AsyncIterable<SessionEvent>;
  /** Snapshot the FS + conversation into a store. */
  snapshot(store: SnapshotStore, opts?: { meta?: unknown }): Promise<{ snapshotId: string }>;
  /** Read a file's raw bytes from the virtual FS. */
  readFile(path: string): Promise<Uint8Array>;
  /** Walk the FS and return every file path. */
  listFiles(): Promise<string[]>;
  /** The conversation so far (for inspection). */
  readonly messages: ModelMessage[];
}

/** Internal: build a Session over an already-constructed kernel + messages. */
function buildSession(
  kernel: Kernel,
  cfg: Omit<SessionConfig, "files"> & { initialMessages?: ModelMessage[] },
): Session {
  const cwd = cfg.cwd ?? "/";
  const shell = new Shell(kernel);
  // createTools() returns a fixed-shape interface; spread into a ToolSet record
  // so the AI SDK's generic `tools` param (which wants an index signature) is happy.
  const tools = { ...createTools({ sys: kernel.sys, shell, cwd }) };
  const system =
    cfg.system ?? defaultSystemPrompt({ cwd, mounts: cfg.mounts, network: cfg.network });
  const maxSteps = cfg.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: ModelMessage[] = cfg.initialMessages ? [...cfg.initialMessages] : [];

  async function* send(prompt: string, opts?: SendOptions): AsyncIterable<SessionEvent> {
    const signal = opts?.signal;
    // New turn: reset per-turn quota counters and add the user message.
    kernel.resetTurn();
    messages.push({ role: "user", content: prompt });

    // Fast path: already aborted before any model call. Emit the terminal
    // aborted event without spending. Only the user message stays appended.
    if (signal?.aborted) {
      yield { type: "error", message: "aborted" };
      return;
    }

    // Optional compaction before the call (no-op when tokenBudget unset).
    // compact() always returns a fresh array, so splicing it back into the live
    // `messages` reference is safe even on short-circuit paths (no aliasing wipe).
    if (cfg.tokenBudget !== undefined) {
      const compacted = compact(messages, cfg.tokenBudget);
      messages.splice(0, messages.length, ...compacted);
    }

    let accumulatedText = "";
    let aborted = false;
    try {
      const result = streamText({
        model: cfg.model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        // Forward the caller's signal so the AI SDK stops the model call + tool
        // loop on abort (no wasted model spend). The `abort` stream part below
        // is emitted by the SDK when this fires mid-stream.
        abortSignal: signal,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "abort": {
            // The AI SDK aborted the call (signal fired mid-stream). Surface a
            // terminal aborted event and stop consuming the stream.
            aborted = true;
            yield { type: "error", message: "aborted" };
            break;
          }
          case "text-delta": {
            accumulatedText += part.text;
            yield { type: "text_delta", text: part.text };
            break;
          }
          case "tool-call": {
            yield {
              type: "tool_call",
              toolCallId: part.toolCallId,
              tool: part.toolName,
              input: part.input,
            };
            break;
          }
          case "tool-result": {
            yield {
              type: "tool_result",
              toolCallId: part.toolCallId,
              tool: part.toolName,
              output: stringifyOutput(part.output),
            };
            break;
          }
          case "tool-error": {
            // @ork.ai/tools wraps execute() so it rarely throws, but surface any
            // tool error as a model-visible result rather than killing the loop.
            yield {
              type: "tool_result",
              toolCallId: part.toolCallId,
              tool: part.toolName,
              output: `Error: ${errText(part.error)}`,
            };
            break;
          }
          case "finish-step": {
            yield { type: "step_finish", finishReason: part.finishReason };
            break;
          }
          case "finish": {
            yield { type: "turn_done", text: accumulatedText, stopReason: part.finishReason };
            break;
          }
          case "error": {
            yield { type: "error", message: errText(part.error) };
            break;
          }
          default:
            // text-start/end, reasoning, tool-input-*, start, start-step, file,
            // source, raw — not part of the public contract.
            break;
        }
        if (aborted) break;
      }

      // Persist whatever assistant + tool messages the turn produced so the
      // next turn has the full context. On abort, result.response resolves to
      // the partial messages (possibly none) — append them best-effort; if it
      // rejects (some providers throw the abort), just keep the user message.
      try {
        const response = await result.response;
        messages.push(...response.messages);
      } catch (err) {
        if (!aborted) throw err;
        // Aborted before any persistable response: only the user message stays.
      }
    } catch (err) {
      // Never throw out of the async iterator: surface as an error event.
      yield { type: "error", message: errText(err) };
    }
  }

  return {
    send,
    messages,
    snapshot: (store, opts) =>
      kernel.snapshot(store, { meta: { messages, ...(opts?.meta as object | undefined) } }),
    readFile: (path) => kernel.sys.readFile(path),
    listFiles: async () => {
      const out: string[] = [];
      await walk(kernel, "/", out);
      out.sort();
      return out;
    },
  };
}

function kernelOptions(cfg: SessionConfig): KernelOptions {
  return {
    files: cfg.files,
    mounts: cfg.mounts,
    network: cfg.network,
    limits: cfg.limits,
    fetchImpl: cfg.fetchImpl,
  };
}

/** Build a kernel + shell + tools synchronously and return a multi-turn Session. */
export function createSession(cfg: SessionConfig): Session {
  if (cfg.workspace && cfg.files) {
    throw new KernelError("EINVAL", "createSession: `workspace` and `files` are mutually exclusive");
  }
  const kernel = cfg.workspace ? cfg.workspace.kernel : createKernel(kernelOptions(cfg));
  return buildSession(kernel, { ...cfg, initialMessages: cfg.messages });
}

export interface RestoreSessionArgs extends Omit<SessionConfig, "files"> {
  store: SnapshotStore;
  snapshotId: string;
}

/**
 * Restore a session from a snapshot: rebuilds the kernel FS lazily and reloads
 * the conversation `messages` from the snapshot meta. Config (model, limits,
 * mounts, network, system, …) is supplied fresh — it is never persisted.
 */
export async function restoreSession(args: RestoreSessionArgs): Promise<Session> {
  const { kernel, meta } = await restoreKernel({
    store: args.store,
    snapshotId: args.snapshotId,
    mounts: args.mounts,
    network: args.network,
    limits: args.limits,
    fetchImpl: args.fetchImpl,
  });
  const initialMessages = extractMessages(meta);
  return buildSession(kernel, { ...args, initialMessages });
}

// ---- helpers ---------------------------------------------------------------

function extractMessages(meta: unknown): ModelMessage[] {
  if (
    meta !== null &&
    typeof meta === "object" &&
    "messages" in meta &&
    Array.isArray((meta as { messages: unknown }).messages)
  ) {
    return (meta as { messages: ModelMessage[] }).messages;
  }
  return [];
}

async function walk(kernel: Kernel, dir: string, out: string[]): Promise<void> {
  const names = await kernel.sys.readdir(dir);
  for (const name of names) {
    const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const st = await kernel.sys.stat(full);
    if (st.kind === "dir") {
      await walk(kernel, full, out);
    } else {
      out.push(full);
    }
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
