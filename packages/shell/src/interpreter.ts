// The interpreter executes a parsed Script over a @ork.ai/kernel instance.
//
// Scope: pipelines of simple commands PLUS compound commands (if/while/for).
// A compound runs its inner Scripts via the statement-execution path, routing
// output through the pipeline's sinks and honoring its trailing redirections.
// Compounds are supported standalone or as the LAST stage of a pipeline (e.g.
// `seq | while read ...`); a compound in any earlier pipeline position throws a
// ShellError (surfaced as exitCode 2). The in-process `read` builtin consumes a
// shell-level stdin buffer the compound sets up from the pipe or `< file`.
//
// Execution limits (ShellOptions.limits) guard against runaway agent scripts:
// a per-exec() command counter (maxCommands) and a per-loop iteration counter
// (maxLoopIterations); exceeding either aborts exec() with exitCode 2.
//
// Key model:
//  - The Shell holds mutable state: cwd + env + lastExit.
//  - Each pipeline command runs as a kernel proc whose CommandContext is a
//    SNAPSHOT of state (cwd/env) at launch, plus any per-command prefix
//    assignments overlaid. cd / assignments / export are shell-state builtins
//    that run IN-PROCESS and mutate state directly (never as procs).
//  - cmdsub recursively constructs a child Shell-like run via runCapture.

import { isKernelError, normalizePath, readText, type Kernel } from "@ork.ai/kernel";
import { parse } from "./parser.js";
import { ShellError, ShellParseError } from "./errors.js";
import { CommandRegistry, defaultRegistry } from "./registry.js";
import {
  expandRedirTarget,
  expandWordSingle,
  expandWords,
  segmentHasGlob,
  segmentToRegExp,
  type ExpandRuntime,
} from "./expand.js";
import type {
  AndOr,
  ForNode,
  IfNode,
  Pipeline,
  Redirection,
  Script,
  SimpleCommand,
  Statement,
  WhileNode,
  Word,
} from "./ast.js";
import type { CommandContext } from "./types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const DEFAULT_MAX_LOOP_ITERATIONS = 100_000;
const DEFAULT_MAX_COMMANDS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ShellLimits {
  /** Max iterations any single loop (while/for) may run before aborting. */
  maxLoopIterations?: number;
  /** Max simple-command/compound executions per exec() call. */
  maxCommands?: number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  registry?: CommandRegistry;
  limits?: ShellLimits;
  /** Per-pipeline wall-clock timeout (ms). On expiry the pipeline is torn down
   * and exec() returns partial output with exit 124. Default 30_000. */
  timeoutMs?: number;
}

// Thrown internally to abort an exec() run when an execution limit is hit. Not a
// ShellError (which maps to a generic "ork-shell: <msg>" prefix); carries the
// exact stderr text and exit code to surface.
class LimitError extends Error {
  constructor(
    readonly stderrText: string,
    readonly code: number,
  ) {
    super(stderrText);
    this.name = "LimitError";
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ShellState {
  cwd: string;
  env: Map<string, string>;
  lastExit: number;
}

// Collected output sinks for an exec() run; pipeline last-stage stdout and all
// stderr append here unless redirected.
interface OutputSink {
  stdout: string[];
  stderr: string[];
}

export class Shell {
  readonly #kernel: Kernel;
  readonly #registry: CommandRegistry;
  readonly #state: ShellState;
  readonly #maxLoopIterations: number;
  readonly #maxCommands: number;
  readonly #timeoutMs: number;
  // Per-exec() command counter; reset at the start of each exec().
  #commandCount = 0;
  // Stdin available to in-process `read` while running a compound body fed by a
  // pipe / `< file`. null when no piped stdin is in scope.
  #stdinBuffer: { text: string; pos: number } | null = null;

  constructor(kernel: Kernel, opts: ShellOptions = {}) {
    this.#kernel = kernel;
    this.#registry = opts.registry ?? defaultRegistry();
    this.#maxLoopIterations = opts.limits?.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
    this.#maxCommands = opts.limits?.maxCommands ?? DEFAULT_MAX_COMMANDS;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = new Map<string, string>();
    for (const [k, v] of Object.entries(opts.env ?? {})) env.set(k, v);
    if (!env.has("HOME")) env.set("HOME", "/");
    const cwd = normalizePath(opts.cwd ?? "/");
    env.set("PWD", cwd);
    this.#state = { cwd, env, lastExit: 0 };
  }

  // Set when the command counter is exceeded inside a spawned proc (ctx.run /
  // xargs). The proc wrapper swallows thrown errors into exit 1, so we record
  // the limit here and re-raise it after the pipeline settles (see
  // #runProcPipeline) to abort exec() cleanly at exit 2.
  #limitHit: LimitError | null = null;

  // Increment the per-exec command counter; throw LimitError when exceeded.
  #countCommand(): void {
    this.#commandCount++;
    if (this.#commandCount > this.#maxCommands) {
      const err = new LimitError("ork-shell: command limit exceeded\n", 2);
      this.#limitHit = err;
      throw err;
    }
  }

  async exec(script: string): Promise<ExecResult> {
    let ast: Script;
    try {
      ast = parse(script);
    } catch (err) {
      if (err instanceof ShellParseError) {
        return { stdout: "", stderr: `ork-shell: ${err.message}\n`, exitCode: 2 };
      }
      throw err;
    }
    const sink: OutputSink = { stdout: [], stderr: [] };
    this.#commandCount = 0;
    this.#limitHit = null;
    try {
      await this.#runScript(ast, sink, 0);
    } catch (err) {
      if (err instanceof LimitError) {
        sink.stderr.push(err.stderrText);
        this.#state.lastExit = err.code;
      } else if (err instanceof ShellError) {
        sink.stderr.push(`ork-shell: ${err.message}\n`);
        this.#state.lastExit = 2;
      } else {
        throw err;
      }
    }
    return {
      stdout: sink.stdout.join(""),
      stderr: sink.stderr.join(""),
      exitCode: this.#state.lastExit,
    };
  }

  // Run all statements sequentially. Background statements are launched but not
  // awaited until the end of the script run (no orphans across exec calls).
  async #runScript(script: Script, sink: OutputSink, cmdsubDepth: number): Promise<void> {
    const background: Array<Promise<void>> = [];
    for (const stmt of script.statements) {
      await this.#runStatement(stmt, sink, cmdsubDepth, background);
    }
    // Await any background pipelines before returning.
    await Promise.all(background);
  }

  async #runStatement(
    stmt: Statement,
    sink: OutputSink,
    cmdsubDepth: number,
    background: Array<Promise<void>>,
  ): Promise<void> {
    if (stmt.background) {
      // Launch the andOr without awaiting; record exit 0 immediately.
      const p = this.#runAndOr(stmt.andOr, sink, cmdsubDepth).then(() => undefined);
      background.push(p);
      this.#state.lastExit = 0;
      return;
    }
    await this.#runAndOr(stmt.andOr, sink, cmdsubDepth);
  }

  async #runAndOr(andOr: AndOr, sink: OutputSink, cmdsubDepth: number): Promise<number> {
    let code = await this.#runPipeline(andOr.first, sink, cmdsubDepth);
    for (const link of andOr.rest) {
      const runNext = link.op === "&&" ? code === 0 : code !== 0;
      if (runNext) code = await this.#runPipeline(link.pipeline, sink, cmdsubDepth);
      // else: short-circuit; keep last code.
    }
    this.#state.lastExit = code;
    return code;
  }

  async #runPipeline(pipeline: Pipeline, sink: OutputSink, cmdsubDepth: number): Promise<number> {
    const cmds = pipeline.commands;
    if (cmds.length === 0) return 0;

    // Compounds may appear only as a standalone single-command pipeline OR as
    // the LAST stage of a pipeline (e.g. `seq | while read ...`). A compound in
    // any non-final position is unsupported.
    for (let i = 0; i < cmds.length - 1; i++) {
      if (cmds[i]!.kind !== "simple") {
        throw new ShellError(
          `compound command '${cmds[i]!.kind}' is only supported as the last stage of a pipeline`,
        );
      }
    }

    const last = cmds[cmds.length - 1]!;
    if (last.kind !== "simple") {
      // Pipeline ending in a compound. If there are upstream stages, run them as
      // a proc pipeline capturing their stdout, then feed it as the compound's
      // stdin (consumed by the `read` builtin).
      let stdin = "";
      if (cmds.length > 1) {
        const upstream = cmds.slice(0, -1) as SimpleCommand[];
        const buf: OutputSink = { stdout: [], stderr: [] };
        await this.#runProcPipeline(upstream, buf, cmdsubDepth);
        // Upstream stderr still goes to the real sink.
        for (const s of buf.stderr) sink.stderr.push(s);
        stdin = buf.stdout.join("");
      }
      return this.#runCompound(last, sink, cmdsubDepth, stdin);
    }

    const simples = cmds as SimpleCommand[];

    // A single simple command may be a shell-state builtin (cd/assignment/export)
    // which must run in-process — only when it is the sole command of the
    // pipeline (bash runs builtins-in-pipeline in subshells; we keep it simple).
    if (simples.length === 1) {
      const handled = await this.#tryStateBuiltin(simples[0]!, sink, cmdsubDepth);
      if (handled !== null) return handled;
    }

    return this.#runProcPipeline(simples, sink, cmdsubDepth);
  }

  // ---- compound commands (if / while / for) --------------------------------

  // Execute a compound node, routing its body/cond output through `sink`,
  // honoring the node's trailing redirections, and making `stdin` available to
  // the `read` builtin during execution.
  async #runCompound(
    node: IfNode | WhileNode | ForNode,
    sink: OutputSink,
    cmdsubDepth: number,
    stdin: string,
  ): Promise<number> {
    this.#countCommand();

    const redirs = node.redirections;
    // When the compound has output redirections, run its body into a private
    // buffer and route afterwards (mirrors simple-command redirection handling).
    const hasOutRedir = redirs.some((r) => r.op === ">" || r.op === ">>" || r.op === "2>&1");
    const stdinRedir = redirs.find((r) => r.op === "<");

    // `< file` on the compound overrides any piped stdin.
    if (stdinRedir) {
      const rt = this.#runtime(cmdsubDepth, this.#state.env);
      const file = await expandRedirTarget(stdinRedir.target!, rt);
      const resolved = normalizePath(file, this.#state.cwd);
      try {
        stdin = dec.decode(await this.#kernel.sys.readFile(resolved));
      } catch (err) {
        if (isKernelError(err) && err.code === "ENOENT") {
          sink.stderr.push(`ork-shell: ${file}: No such file or directory\n`);
          this.#state.lastExit = 1;
          return 1;
        }
        throw err;
      }
    }

    const target = hasOutRedir ? { stdout: [] as string[], stderr: [] as string[] } : sink;

    // Install stdin for any `read` builtins encountered while running the body.
    const savedStdin = this.#stdinBuffer;
    this.#stdinBuffer = { text: stdin, pos: 0 };
    let code: number;
    try {
      if (node.kind === "if") code = await this.#runIf(node, target, cmdsubDepth);
      else if (node.kind === "while") code = await this.#runWhile(node, target, cmdsubDepth);
      else code = await this.#runFor(node, target, cmdsubDepth);
    } finally {
      this.#stdinBuffer = savedStdin;
    }

    if (hasOutRedir) {
      await this.#routeCompoundRedir(redirs, target as OutputSink, sink, cmdsubDepth);
    }

    this.#state.lastExit = code;
    return code;
  }

  async #runIf(node: IfNode, sink: OutputSink, cmdsubDepth: number): Promise<number> {
    for (const clause of node.clauses) {
      const condCode = await this.#runScriptReturningExit(clause.cond, sink, cmdsubDepth);
      if (condCode === 0) {
        return this.#runScriptReturningExit(clause.body, sink, cmdsubDepth);
      }
    }
    if (node.elseBody) {
      return this.#runScriptReturningExit(node.elseBody, sink, cmdsubDepth);
    }
    // No clause matched and no else: exit 0.
    return 0;
  }

  async #runWhile(node: WhileNode, sink: OutputSink, cmdsubDepth: number): Promise<number> {
    let code = 0;
    let iterations = 0;
    for (;;) {
      const condCode = await this.#runScriptReturningExit(node.cond, sink, cmdsubDepth);
      if (condCode !== 0) break;
      if (++iterations > this.#maxLoopIterations) {
        throw new LimitError("ork-shell: loop iteration limit exceeded\n", 2);
      }
      code = await this.#runScriptReturningExit(node.body, sink, cmdsubDepth);
    }
    return code;
  }

  async #runFor(node: ForNode, sink: OutputSink, cmdsubDepth: number): Promise<number> {
    const rt = this.#runtime(cmdsubDepth, this.#state.env);
    const values = await expandWords(node.items, rt);
    let code = 0;
    let iterations = 0;
    for (const value of values) {
      if (++iterations > this.#maxLoopIterations) {
        throw new LimitError("ork-shell: loop iteration limit exceeded\n", 2);
      }
      this.#state.env.set(node.varName, value);
      code = await this.#runScriptReturningExit(node.body, sink, cmdsubDepth);
    }
    return code;
  }

  // Run a Script (a sequence of statements) and return the exit code of the
  // last-executed statement. Background statements are awaited before return.
  async #runScriptReturningExit(
    script: Script,
    sink: OutputSink,
    cmdsubDepth: number,
  ): Promise<number> {
    const background: Array<Promise<void>> = [];
    for (const stmt of script.statements) {
      await this.#runStatement(stmt, sink, cmdsubDepth, background);
    }
    await Promise.all(background);
    return this.#state.lastExit;
  }

  // Route a compound's buffered output to its redirection targets. Mirrors the
  // simple-command routing: `2>&1` merges stderr into stdout (and the stdout
  // target/sink), `>`/`>>` to files, otherwise to the shared sink.
  async #routeCompoundRedir(
    redirs: Redirection[],
    buf: OutputSink,
    sink: OutputSink,
    cmdsubDepth: number,
  ): Promise<void> {
    const rt = this.#runtime(cmdsubDepth, this.#state.env);
    const merge = redirs.some((r) => r.op === "2>&1");
    let stdoutTarget: { path: string; append: boolean } | null = null;
    let stderrTarget: { path: string; append: boolean } | null = null;
    for (const r of redirs) {
      if (r.op === ">" || r.op === ">>") {
        const file = await expandRedirTarget(r.target!, rt);
        const dest = { path: normalizePath(file, this.#state.cwd), append: r.op === ">>" };
        if (r.fd === 2) stderrTarget = dest;
        else stdoutTarget = dest;
      }
    }

    let outText = buf.stdout.join("");
    const errText = buf.stderr.join("");
    if (merge) outText += errText;

    if (stdoutTarget) {
      await this.#writeToFile(stdoutTarget, outText, sink);
    } else {
      sink.stdout.push(outText);
    }
    if (!merge) {
      if (stderrTarget) {
        await this.#writeToFile(stderrTarget, errText, sink);
      } else {
        sink.stderr.push(errText);
      }
    }
  }

  // ---- shell-state builtins (in-process) ----------------------------------

  // Returns exit code if handled as a state builtin, or null if this is a normal
  // command to run as a proc.
  async #tryStateBuiltin(
    cmd: SimpleCommand,
    sink: OutputSink,
    cmdsubDepth: number,
  ): Promise<number | null> {
    const rt = this.#runtime(cmdsubDepth, this.#state.env);

    // Assignment-only command (no words): set shell env, expand values.
    if (cmd.words.length === 0 && cmd.assignments.length > 0) {
      this.#countCommand();
      for (const a of cmd.assignments) {
        const value = await expandWordSingle(a.value, rt);
        this.#state.env.set(a.name, value);
      }
      return 0;
    }

    if (cmd.words.length === 0) return null; // pure redirection — fall to proc path

    // Detect cd/export by the STATIC first word (a single unquoted literal). We
    // never expand here to avoid double-running command substitutions; bash's
    // builtins-after-expansion subtlety does not matter for cd/export, which are
    // always written as bare literals in practice.
    const name = staticLiteral(cmd.words[0]!);
    if (name === "cd") {
      this.#countCommand();
      return this.#builtinCd(cmd, sink, rt);
    }
    if (name === "export") {
      this.#countCommand();
      return this.#builtinExport(cmd, rt);
    }
    if (name === "read") return this.#builtinRead(cmd, rt);

    return null;
  }

  // read VAR: consume one line from the in-scope stdin buffer, strip the
  // trailing newline, assign to VAR. EOF (no buffer or buffer exhausted) → no
  // assignment and exit 1. Without a VAR argument, reads into REPLY.
  async #builtinRead(cmd: SimpleCommand, rt: ExpandRuntime): Promise<number> {
    this.#countCommand();
    const fields = await expandWords(cmd.words, rt);
    const varName = fields[1] ?? "REPLY";
    const buf = this.#stdinBuffer;
    if (!buf || buf.pos >= buf.text.length) return 1;
    let nl = buf.text.indexOf("\n", buf.pos);
    let line: string;
    if (nl === -1) {
      line = buf.text.slice(buf.pos);
      buf.pos = buf.text.length;
    } else {
      line = buf.text.slice(buf.pos, nl);
      buf.pos = nl + 1;
    }
    this.#state.env.set(varName, line);
    return 0;
  }

  async #builtinCd(cmd: SimpleCommand, sink: OutputSink, rt: ExpandRuntime): Promise<number> {
    const fields = await expandWords(cmd.words, rt);
    const args = fields.slice(1);
    const target = args[0] ?? this.#state.env.get("HOME") ?? "/";
    const resolved = normalizePath(target, this.#state.cwd);
    try {
      const st = await this.#kernel.sys.stat(resolved);
      if (st.kind !== "dir") {
        sink.stderr.push(`cd: ${target}: Not a directory\n`);
        this.#state.lastExit = 1;
        return 1;
      }
    } catch (err) {
      if (isKernelError(err) && err.code === "ENOENT") {
        sink.stderr.push(`cd: ${target}: No such file or directory\n`);
        this.#state.lastExit = 1;
        return 1;
      }
      throw err;
    }
    this.#state.cwd = resolved;
    this.#state.env.set("PWD", resolved);
    return 0;
  }

  // export FOO=bar → assignment; export FOO → no-op (all vars exported in v1).
  async #builtinExport(cmd: SimpleCommand, rt: ExpandRuntime): Promise<number> {
    for (const a of cmd.assignments) {
      const value = await expandWordSingle(a.value, rt);
      this.#state.env.set(a.name, value);
    }
    // Remaining words after `export`: each may be NAME=value or NAME.
    const fields = await expandWords(cmd.words.slice(1), rt);
    for (const f of fields) {
      const eq = f.indexOf("=");
      if (eq > 0) {
        this.#state.env.set(f.slice(0, eq), f.slice(eq + 1));
      }
      // bare NAME: already exported (no-op).
    }
    return 0;
  }

  // ---- proc pipeline -------------------------------------------------------

  async #runProcPipeline(
    cmds: SimpleCommand[],
    sink: OutputSink,
    cmdsubDepth: number,
  ): Promise<number> {
    // Build, per command: expanded argv, prefix env overlay, redirection plan.
    interface Plan {
      argv: string[];
      env: Map<string, string>;
      redirs: Redirection[];
      stdinFile: string | null; // resolved path for `< file`
      heredoc: string | null;
      stdoutFile: { path: string; append: boolean } | null;
      stderrFile: { path: string; append: boolean } | null;
      mergeStderrToStdout: boolean; // 2>&1
      // Set when redirection setup failed before launch (e.g. `<` ENOENT).
      preError: { message: string } | null;
      // Exit code of the last cmdsub run during this command's expansion. Used
      // when the command has no actual program (empty argv): bash takes the
      // exit status of the last command substitution executed.
      lastCmdsubExit: number | null;
    }

    const plans: Plan[] = [];
    for (const cmd of cmds) {
      this.#countCommand();
      // Per-command env = shell env + prefix assignments (overlay).
      const env = new Map(this.#state.env);
      const tracker = { lastCmdsubExit: null as number | null };
      const rt = this.#runtime(cmdsubDepth, env, tracker);
      for (const a of cmd.assignments) {
        env.set(a.name, await expandWordSingle(a.value, rt));
      }
      const argv = await expandWords(cmd.words, rt);

      const plan: Plan = {
        argv,
        env,
        redirs: cmd.redirections,
        stdinFile: null,
        heredoc: null,
        stdoutFile: null,
        stderrFile: null,
        mergeStderrToStdout: false,
        preError: null,
        lastCmdsubExit: tracker.lastCmdsubExit,
      };

      for (const r of cmd.redirections) {
        if (r.op === "heredoc") {
          plan.heredoc = await this.#expandHeredoc(r.heredoc!, rt);
        } else if (r.op === "2>&1") {
          plan.mergeStderrToStdout = true;
        } else if (r.op === "<") {
          const file = await expandRedirTarget(r.target!, rt);
          const resolved = normalizePath(file, this.#state.cwd);
          try {
            const data = await this.#kernel.sys.readFile(resolved);
            plan.stdinFile = resolved;
            (plan as Plan & { stdinData?: Uint8Array }).stdinData = data;
          } catch (err) {
            if (isKernelError(err) && err.code === "ENOENT") {
              plan.preError = { message: `ork-shell: ${file}: No such file or directory` };
            } else {
              throw err;
            }
          }
        } else if (r.op === ">" || r.op === ">>") {
          const file = await expandRedirTarget(r.target!, rt);
          const resolved = normalizePath(file, this.#state.cwd);
          const dest = { path: resolved, append: r.op === ">>" };
          if (r.fd === 2) plan.stderrFile = dest;
          else plan.stdoutFile = dest;
        }
      }
      plans.push(plan);
    }

    // Launch procs. Commands with a preError do not run (exit 1, message to
    // stderr sink). For simplicity each command in the pipeline is independent;
    // a failing redirection only affects that command's slot.
    //
    // We collect every proc's stdout and stderr so we can route them after the
    // pipeline completes (to file or to the shared sink). Adjacent procs are
    // connected stdout→stdin via table.pipe; we instead manually bridge because
    // we also need to tee non-final stdout to the next proc only.
    const procHandles: Array<ReturnType<Kernel["procs"]["spawn"]> | null> = [];

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!;
      if (plan.preError) {
        sink.stderr.push(plan.preError.message + "\n");
        procHandles.push(null);
        continue;
      }
      const name = plan.argv[0];
      if (name === undefined) {
        // Pure-redirection command with no argv: nothing to run, success.
        procHandles.push(null);
        continue;
      }
      const impl = this.#registry.get(name);
      if (!impl) {
        sink.stderr.push(`ork-shell: ${name}: command not found\n`);
        procHandles.push(null);
        continue;
      }
      const ctx0: Omit<CommandContext, "stdin" | "stdout" | "stderr"> = {
        argv: plan.argv,
        sys: this.#kernel.sys,
        cwd: this.#state.cwd,
        env: plan.env,
        resolve: (p: string) => normalizePath(p, this.#state.cwd),
        run: (argv: string[], stdin?: string) => this.#runOneOff(argv, plan.env, stdin ?? ""),
      };
      const handle = this.#kernel.procs.spawn(plan.argv, async (io) => {
        const ctx: CommandContext = {
          ...ctx0,
          argv: io.argv,
          stdin: io.stdin,
          stdout: io.stdout,
          stderr: io.stderr,
        };
        try {
          return await impl(ctx);
        } catch (err) {
          await this.#writeStderr(io.stderr, this.#formatCmdError(name, err));
          return this.#errorExitCode(err);
        }
      });
      procHandles.push(handle);
    }

    // For a non-last proc, does its stderr get merged into the downstream pipe?
    // (2>&1 with no stdout-file redirect → stdout AND stderr feed next.stdin.)
    const nonLastMergeToPipe = (i: number): boolean =>
      i < procHandles.length - 1 &&
      plans[i]!.mergeStderrToStdout &&
      plans[i]!.stdoutFile === null;

    // Teardown hooks for the inter-proc pipes we manage ourselves (one per
    // connected pair). Calling a hook cancels the producer's stdout source and
    // aborts the consumer's stdin, breaking backpressure so a blocked producer
    // unwinds. We manage the pipe (rather than kernel.procs.pipe) precisely so
    // we retain a handle to abort it for SIGPIPE-ish teardown and on timeout.
    const pipeTeardowns: Array<() => void> = [];

    // Wire stdin for the first runnable proc and pipes between adjacent procs.
    // First proc stdin: heredoc / `< file` / empty.
    for (let i = 0; i < procHandles.length; i++) {
      const handle = procHandles[i];
      if (!handle) continue;
      const plan = plans[i]!;
      const prev = i > 0 ? procHandles[i - 1] : null;
      if (prev) {
        // Connect prev stdout → this stdin. If prev has 2>&1 (and no stdout
        // file), merge prev's stderr into the same pipe so the downstream stage
        // sees both streams (Issue #3). Otherwise just its stdout.
        const merge = nonLastMergeToPipe(i - 1);
        pipeTeardowns.push(this.#pipeStreams(prev, handle, merge));
      } else {
        // First (or first-after-a-gap) proc: feed configured stdin then close.
        await this.#feedStdin(handle.stdin, plan);
      }
    }

    // For procs that follow a null/non-runnable slot, their stdin never gets a
    // producer; close it so they see EOF.
    for (let i = 0; i < procHandles.length; i++) {
      const handle = procHandles[i];
      if (!handle) continue;
      const prev = i > 0 ? procHandles[i - 1] : null;
      if (i > 0 && !prev) {
        await this.#closeStdin(handle.stdin);
      }
    }

    // Collect output of every runnable proc and route it.
    let lastExit = 0;
    let lastWriteFailed = false;
    let terminalDone: () => void = () => {};
    const terminalResolved = new Promise<void>((r) => {
      terminalDone = r;
    });
    const collectors: Array<Promise<void>> = [];
    for (let i = 0; i < procHandles.length; i++) {
      const handle = procHandles[i];
      const plan = plans[i]!;
      if (!handle) {
        // Non-runnable slot: command not found / preError → exit code.
        if (i === procHandles.length - 1) {
          if (plan.preError) lastExit = 1;
          else if (plan.argv[0] === undefined) {
            // No program (empty argv): take the last cmdsub exit, else 0.
            lastExit = plan.lastCmdsubExit ?? 0;
          } else lastExit = 127;
        }
        continue;
      }
      const isLast = i === procHandles.length - 1;
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];

      // Non-last procs have their stdout consumed by the pipe; but we still want
      // to ensure it drains. The kernel pipe (pipeTo) consumes it. For the last
      // proc (or any proc whose stdout is redirected to a file), we read here.
      const consumeStdout = isLast || plan.stdoutFile !== null;
      // When a non-last proc's stderr is merged into the downstream pipe, we
      // must NOT also drain it here (pipeMerged owns it); doing so would steal
      // chunks. We still drain stderr otherwise so the proc can exit.
      const stderrToPipe = nonLastMergeToPipe(i);
      const stdoutPromise = consumeStdout
        ? this.#collectStream(handle.stdout, stdoutChunks)
        : Promise.resolve();
      const stderrPromise = stderrToPipe
        ? Promise.resolve()
        : this.#collectStream(handle.stderr, stderrChunks);

      collectors.push(
        (async () => {
          const code = await handle.exit;
          await stdoutPromise;
          await stderrPromise;
          if (isLast) {
            lastExit = code;
            // Terminal proc done: signal upstream teardown (Issue #1b).
            terminalDone();
          }
          // Route stdout.
          if (consumeStdout) {
            let outText = dec.decode(concat(stdoutChunks));
            if (plan.mergeStderrToStdout) {
              outText += dec.decode(concat(stderrChunks));
            }
            if (plan.stdoutFile) {
              const ok = await this.#writeToFile(plan.stdoutFile, outText, sink);
              if (!ok && isLast) lastWriteFailed = true;
            } else if (isLast) {
              sink.stdout.push(outText);
            }
          }
          // Route stderr (unless merged into stdout above, or fed to the pipe).
          if (!plan.mergeStderrToStdout) {
            const errText = dec.decode(concat(stderrChunks));
            if (plan.stderrFile) {
              const ok = await this.#writeToFile(plan.stderrFile, errText, sink);
              if (!ok && isLast) lastWriteFailed = true;
            } else {
              sink.stderr.push(errText);
            }
          }
          // else: mergeStderrToStdout — for a non-last stage stderr went into
          // the pipe (stderrToPipe) and is handled downstream; for a consumed
          // stage it was appended to outText above.
        })(),
      );
    }

    // Issue #1b — proactive upstream teardown. Once the terminal proc has
    // exited and its output is collected, tear down every inter-proc pipe:
    // this cancels each producer's stdout source and aborts each consumer's
    // stdin, releasing any producer blocked on stdout backpressure so its exit
    // resolves and Promise.all(collectors) does not wait on it forever.
    const teardownPipes = (): void => {
      for (const t of pipeTeardowns) t();
    };
    void terminalResolved.then(teardownPipes);

    // Issue #1a — wall-clock backstop. Race the collectors against a timer; on
    // timeout, tear down every proc's streams so nothing stays pending, then
    // return partial output with exit 124. clearTimeout in finally so no
    // dangling timer keeps the event loop alive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#timeoutMs);
    });
    try {
      const all = Promise.all(collectors).then(() => "done" as const);
      const winner = await Promise.race([all, timeout]);
      if (winner === "timeout") {
        timedOut = true;
        // Tear down every inter-proc pipe (releases backpressure) and cancel
        // any streams we still own so nothing stays pending. We do NOT await
        // the collectors here: a proc whose main never returns (e.g. an
        // infinite await) would keep Promise.all pending forever. A bare
        // pending promise does not keep the Node event loop alive, so leaving
        // collectors unawaited is safe and the process/test still exits.
        teardownPipes();
        for (const h of procHandles) {
          if (!h) continue;
          // For the terminal/file-collected proc we own the readable side.
          void h.stdout.cancel().catch(() => {});
          void h.stderr.cancel().catch(() => {});
        }
        sink.stderr.push("ork-shell: pipeline timed out\n");
        lastExit = 124;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // If a spawned proc (ctx.run/xargs) hit the command limit, abort exec()
    // cleanly: re-raise past the proc wrapper so exec()'s top-level handler
    // emits the message on stderr at exit 2 (Issue #2).
    if (this.#limitHit && !timedOut) throw this.#limitHit;

    if (!timedOut && lastWriteFailed) lastExit = 1;
    this.#state.lastExit = lastExit;
    return lastExit;
  }

  // Connect `from`'s stdout (and, when `merge`, its stderr — for a non-last
  // 2>&1 stage, Issue #3) into `to`'s stdin. Unlike the kernel's fire-and-forget
  // pipe, we drive the pump with our own reader/writer so we can tear it down:
  // the returned function cancels the source reader(s) and aborts the dest
  // writer, releasing a producer blocked on backpressure (SIGPIPE-ish, Issue
  // #1). Closes `to`'s stdin once the source(s) drain. Errors are swallowed.
  #pipeStreams(
    from: ReturnType<Kernel["procs"]["spawn"]>,
    to: ReturnType<Kernel["procs"]["spawn"]>,
    merge: boolean,
  ): () => void {
    const writer = to.stdin.getWriter();
    const outReader = from.stdout.getReader();
    const errReader = merge ? from.stderr.getReader() : null;

    const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) await writer.write(value);
      }
    };

    void (async () => {
      try {
        const pumps = [pump(outReader)];
        if (errReader) pumps.push(pump(errReader));
        await Promise.all(pumps);
        await writer.close();
      } catch {
        try {
          await writer.abort();
        } catch {
          /* ignore */
        }
      }
    })();

    // Teardown: cancel sources (unblocks the producer's writes) and abort the
    // dest. Each is best-effort; locking/closed-state errors are ignored.
    return () => {
      void outReader.cancel().catch(() => {});
      void errReader?.cancel().catch(() => {});
      void writer.abort().catch(() => {});
    };
  }

  // ---- one-off command spawn (ctx.run) ------------------------------------

  // Spawn a single registered command as a proc with the current cwd and the
  // given env overlay, feed it `stdin`, and collect stdout/stderr. Bounded by
  // the same per-exec command counter so xargs etc. cannot run unbounded.
  async #runOneOff(
    argv: string[],
    env: ReadonlyMap<string, string>,
    stdin: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Check the command counter BEFORE spawning so hitting the limit aborts the
    // whole exec() cleanly (exit 2) rather than leaking the limit message into
    // the spawning command's output. We record the limit and return a quiet
    // non-zero sentinel; #runProcPipeline re-raises it past the proc wrapper.
    if (this.#commandCount + 1 > this.#maxCommands) {
      this.#limitHit ??= new LimitError("ork-shell: command limit exceeded\n", 2);
      return { stdout: "", stderr: "", exitCode: 2 };
    }
    this.#countCommand();
    const name = argv[0];
    if (name === undefined) return { stdout: "", stderr: "", exitCode: 0 };
    const impl = this.#registry.get(name);
    if (!impl) {
      return { stdout: "", stderr: `ork-shell: ${name}: command not found\n`, exitCode: 127 };
    }
    const cwd = this.#state.cwd;
    const ctx0: Omit<CommandContext, "stdin" | "stdout" | "stderr"> = {
      argv,
      sys: this.#kernel.sys,
      cwd,
      env,
      resolve: (p: string) => normalizePath(p, cwd),
      run: (a: string[], s?: string) => this.#runOneOff(a, env, s ?? ""),
    };
    const handle = this.#kernel.procs.spawn(argv, async (io) => {
      const ctx: CommandContext = {
        ...ctx0,
        argv: io.argv,
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
      };
      try {
        return await impl(ctx);
      } catch (err) {
        await this.#writeStderr(io.stderr, this.#formatCmdError(name, err));
        return this.#errorExitCode(err);
      }
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    await this.#feedStdin(handle.stdin, { heredoc: stdin, stdinFile: null });
    const outP = this.#collectStream(handle.stdout, stdoutChunks);
    const errP = this.#collectStream(handle.stderr, stderrChunks);
    const exitCode = await handle.exit;
    await outP;
    await errP;
    return {
      stdout: dec.decode(concat(stdoutChunks)),
      stderr: dec.decode(concat(stderrChunks)),
      exitCode,
    };
  }

  // ---- stdin feeding -------------------------------------------------------

  async #feedStdin(
    stdin: WritableStream<Uint8Array>,
    plan: { heredoc: string | null } & { stdinData?: Uint8Array; stdinFile: string | null },
  ): Promise<void> {
    const writer = stdin.getWriter();
    try {
      if (plan.heredoc !== null) {
        await writer.write(enc.encode(plan.heredoc));
      } else if (plan.stdinFile !== null && plan.stdinData) {
        await writer.write(plan.stdinData);
      }
      await writer.close();
    } catch {
      try {
        writer.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  async #closeStdin(stdin: WritableStream<Uint8Array>): Promise<void> {
    try {
      const w = stdin.getWriter();
      await w.close();
    } catch {
      /* already closed */
    }
  }

  async #collectStream(stream: ReadableStream<Uint8Array>, into: Uint8Array[]): Promise<void> {
    for await (const chunk of stream) into.push(chunk);
  }

  async #writeStderr(stream: WritableStream<Uint8Array>, text: string): Promise<void> {
    try {
      const w = stream.getWriter();
      await w.write(enc.encode(text));
      w.releaseLock();
    } catch {
      /* ignore */
    }
  }

  // Returns true on success, false if the write failed (message already pushed).
  async #writeToFile(
    dest: { path: string; append: boolean },
    text: string,
    sink: OutputSink,
  ): Promise<boolean> {
    try {
      let payload = text;
      if (dest.append) {
        try {
          const existing = await this.#kernel.sys.readFile(dest.path);
          payload = dec.decode(existing) + text;
        } catch (err) {
          if (!(isKernelError(err) && err.code === "ENOENT")) throw err;
        }
      }
      await this.#kernel.sys.writeFile(dest.path, payload);
      return true;
    } catch (err) {
      const msg = isKernelError(err) ? err.message : String(err);
      sink.stderr.push(`ork-shell: ${dest.path}: ${msg}\n`);
      return false;
    }
  }

  #formatCmdError(name: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return `${name}: ${msg}\n`;
  }

  #errorExitCode(err: unknown): number {
    if (isKernelError(err)) {
      return err.code === "EQUOTA" ? 126 : 1;
    }
    return 1;
  }

  // ---- heredoc -------------------------------------------------------------

  // Expand a heredoc body. When expand=false the body is verbatim. When true we
  // perform textual $VAR / ${VAR} / $(...) expansion (no field-splitting, no
  // globbing) over the raw body.
  async #expandHeredoc(
    hd: { body: string; expand: boolean },
    rt: ExpandRuntime,
  ): Promise<string> {
    if (!hd.expand) return hd.body;
    const src = hd.body;
    let out = "";
    let i = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\" && src[i + 1] === "$") {
        out += "$";
        i += 2;
        continue;
      }
      if (c !== "$") {
        out += c;
        i++;
        continue;
      }
      // c === "$"
      const next = src[i + 1] ?? "";
      if (next === "(") {
        // $(...) — find matching close paren honoring nesting.
        const { body, end } = readParenBody(src, i + 2);
        if (end === -1) {
          out += "$";
          i++;
          continue;
        }
        if (rt.cmdsubDepth >= 16) {
          throw new ShellError("command substitution nested too deep (max 16)");
        }
        const res = await rt.runCapture(body);
        out += stripTrailingNl(res.stdout);
        i = end;
        continue;
      }
      if (next === "{") {
        const close = src.indexOf("}", i + 2);
        if (close === -1) {
          out += "$";
          i++;
          continue;
        }
        const name = src.slice(i + 2, close);
        out += rt.lookup(name) ?? "";
        i = close + 1;
        continue;
      }
      if (/[A-Za-z_]/.test(next)) {
        let j = i + 1;
        let name = "";
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) {
          name += src[j]!;
          j++;
        }
        out += rt.lookup(name) ?? "";
        i = j;
        continue;
      }
      if ("?$!#@*0123456789".includes(next)) {
        out += rt.lookup(next) ?? "";
        i += 2;
        continue;
      }
      out += "$";
      i++;
    }
    return out;
  }

  // ---- expansion runtime ---------------------------------------------------

  #runtime(
    cmdsubDepth: number,
    env: ReadonlyMap<string, string>,
    tracker?: { lastCmdsubExit: number | null },
  ): ExpandRuntime {
    return {
      cmdsubDepth,
      lookup: (name: string) => this.#lookupVar(name, env),
      runCapture: async (script: string) => {
        const res = await this.#runCapture(script, cmdsubDepth + 1);
        if (tracker) tracker.lastCmdsubExit = res.exitCode;
        return res;
      },
      glob: (pattern: string) => this.#glob(pattern),
    };
  }

  #lookupVar(name: string, env: ReadonlyMap<string, string>): string | undefined {
    if (name === "?") return String(this.#state.lastExit);
    if (name === "PWD") return this.#state.cwd;
    if (name === "HOME") return env.get("HOME") ?? this.#state.env.get("HOME") ?? "/";
    return env.get(name);
  }

  // Recursively run a script capturing its stdout. Shares this Shell's state so
  // cmdsub sees cwd/env (bash runs cmdsub in a subshell — state changes inside
  // do not leak; we approximate by sharing state but NOT persisting cd/env
  // changes: snapshot + restore around the run).
  async #runCapture(script: string, cmdsubDepth: number): Promise<{ stdout: string; exitCode: number }> {
    if (cmdsubDepth > 16) {
      throw new ShellError("command substitution nested too deep (max 16)");
    }
    let ast: Script;
    try {
      ast = parse(script);
    } catch (err) {
      if (err instanceof ShellParseError) {
        // Surface parse errors as captured stderr-less failure.
        return { stdout: "", exitCode: 2 };
      }
      throw err;
    }
    // Subshell semantics: snapshot cwd/env/lastExit, restore after.
    const savedCwd = this.#state.cwd;
    const savedEnv = new Map(this.#state.env);
    const savedExit = this.#state.lastExit;
    const sink: OutputSink = { stdout: [], stderr: [] };
    try {
      await this.#runScript(ast, sink, cmdsubDepth);
    } catch (err) {
      if (err instanceof ShellError) {
        sink.stderr.push(`ork-shell: ${err.message}\n`);
        this.#state.lastExit = 2;
      } else {
        throw err;
      }
    }
    const exitCode = this.#state.lastExit;
    // Restore subshell state.
    this.#state.cwd = savedCwd;
    this.#state.env = savedEnv;
    this.#state.lastExit = savedExit;
    return { stdout: sink.stdout.join(""), exitCode };
  }

  // ---- glob ----------------------------------------------------------------

  async #glob(pattern: string): Promise<string[] | null> {
    const absolute = pattern.startsWith("/");
    const segments = pattern.split("/").filter((s, idx) => !(idx === 0 && s === "")); // drop leading "" for absolute
    // Reconstruct: walk from base directory matching each segment.
    const baseDir = absolute ? "/" : this.#state.cwd;
    let frontier: string[] = [baseDir];
    let matchedAny = false;

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]!;
      if (seg === "") continue; // collapse empty (e.g. trailing slash)
      const isLast = si === segments.length - 1;
      const next: string[] = [];
      if (segmentHasGlob(seg)) {
        matchedAny = true;
        const re = segmentToRegExp(seg);
        const matchDot = seg.startsWith(".");
        for (const dir of frontier) {
          let names: string[];
          try {
            names = await this.#kernel.sys.readdir(dir);
          } catch {
            continue; // not a dir / missing
          }
          for (const nm of names.sort()) {
            if (!matchDot && nm.startsWith(".")) continue;
            if (!re.test(nm)) continue;
            const full = dir === "/" ? `/${nm}` : `${dir}/${nm}`;
            if (isLast) {
              next.push(full);
            } else {
              // must be a directory to descend
              try {
                const st = await this.#kernel.sys.stat(full);
                if (st.kind === "dir") next.push(full);
              } catch {
                /* skip */
              }
            }
          }
        }
      } else {
        // literal segment: append to each frontier path, verify existence on last
        for (const dir of frontier) {
          const full = dir === "/" ? `/${seg}` : `${dir}/${seg}`;
          if (isLast) {
            // existence not required for literal-only; but since we only call
            // glob when a glob char is present somewhere, a literal last segment
            // following a globbed parent should still verify existence.
            try {
              await this.#kernel.sys.stat(full);
              next.push(full);
            } catch {
              /* skip */
            }
          } else {
            next.push(full);
          }
        }
      }
      frontier = next;
    }

    if (!matchedAny) return null; // no glob metachar actually expanded
    if (frontier.length === 0) return null;
    return frontier.sort();
  }
}

// If a Word is a single unquoted literal, return its text; else null. Used to
// statically recognize the cd/export builtins without expanding (which could
// run command substitutions prematurely).
function staticLiteral(word: Word): string | null {
  if (word.length !== 1) return null;
  const p = word[0]!;
  if (p.kind === "literal" && !p.quoted) return p.text;
  return null;
}

function stripTrailingNl(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "\n") end--;
  return s.slice(0, end);
}

// Read the body of $( ... ) starting at index `start` (just past the "("),
// returning the inner text and the index just past the closing ")". Tracks
// nesting depth. Returns end=-1 if unterminated.
function readParenBody(src: string, start: number): { body: string; end: number } {
  let depth = 1;
  let i = start;
  let body = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { body, end: i + 1 };
    }
    body += c;
    i++;
  }
  return { body, end: -1 };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
