/**
 * The public event union emitted by {@link Session.send}. This is the contract
 * the server (SSE) and any UI consume — it is deliberately small and stable,
 * decoupled from the AI SDK's internal `TextStreamPart` shape.
 *
 * Mapping from AI SDK `streamText().fullStream` parts (ai@5):
 *  - `text-delta`   → `text_delta`   (uses `part.text`)
 *  - `tool-call`    → `tool_call`    (`toolCallId`, `toolName`, `input`)
 *  - `tool-result`  → `tool_result`  (`toolCallId`, `toolName`, `output` stringified)
 *  - `tool-error`   → `tool_result`  (output = the error message; tools rarely throw
 *                                     since @ork.ai/tools wraps execute in safeExecute)
 *  - `finish-step`  → `step_finish`  (`finishReason`)
 *  - `finish`       → `turn_done`    (accumulated text + `finishReason` as stopReason)
 *  - `error`        → `error`        (stringified error message)
 */
export type SessionEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCallId: string; tool: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; tool: string; output: string }
  | { type: "step_finish"; finishReason: string }
  | { type: "turn_done"; text: string; stopReason: string }
  | { type: "error"; message: string };
