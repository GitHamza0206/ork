// Recursive-descent parser for the @ork.ai/shell bash subset.
//
// Grammar (informal):
//   script     := (statement (separator statement)* )?
//   statement  := and_or ('&' | ';' | newline)?
//   and_or     := pipeline (('&&' | '||') pipeline)*
//   pipeline   := command ('|' command)*
//   command    := if | while | for | simple
//   simple     := (assignment)* (word | redirection)+   (at least one word OR redir)
//
// Reserved words (if/then/elif/else/fi/while/do/done/for/in) are only treated
// as keywords when they appear in command position as a bare unquoted word.

import { ShellParseError } from "./errors.js";
import { tokenize, type Token } from "./lexer.js";
import type {
  Script,
  Statement,
  AndOr,
  Pipeline,
  CommandNode,
  SimpleCommand,
  IfNode,
  IfClause,
  WhileNode,
  ForNode,
  Redirection,
  Assignment,
  Word,
} from "./ast.js";

const MAX_DEPTH = 100;

const RESERVED = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "in",
]);

// Words that close a compound-command body. parseStatements stops before these
// when collecting a nested list.
const TERMINATORS = new Set(["then", "elif", "else", "fi", "do", "done"]);

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Parser {
  private i = 0;
  private depth = 0;

  constructor(private readonly toks: Token[]) {}

  private get cur(): Token {
    // tokenize() always ends with EOF, so this is always defined.
    return this.toks[this.i] as Token;
  }

  private error(message: string): never {
    throw new ShellParseError(message, this.cur.line);
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) this.error(`maximum nesting depth exceeded (${MAX_DEPTH})`);
  }
  private leave(): void {
    this.depth--;
  }

  private advance(): Token {
    const t = this.cur;
    if (t.type !== "EOF") this.i++;
    return t;
  }

  // True if the current token is a bare unquoted word equal to `kw`.
  private isKeyword(kw: string): boolean {
    const t = this.cur;
    return t.type === "WORD" && t.bare === true && t.text === kw;
  }

  // Skip newline tokens (used inside compound commands where lines separate).
  private skipNewlines(): void {
    while (this.cur.type === "NEWLINE") this.i++;
  }

  // Skip newlines and bare ';' separators.
  private skipSeparators(): void {
    for (;;) {
      if (this.cur.type === "NEWLINE") {
        this.i++;
        continue;
      }
      if (this.cur.type === "OP" && this.cur.text === ";") {
        this.i++;
        continue;
      }
      break;
    }
  }

  // ---- top level -----------------------------------------------------------

  parseScript(): Script {
    const script = this.parseStatements(/* topLevel */ true);
    if (this.cur.type !== "EOF") {
      this.error(`unexpected token '${this.tokenLabel(this.cur)}'`);
    }
    return script;
  }

  private tokenLabel(t: Token): string {
    if (t.type === "WORD") return t.text || "<word>";
    if (t.type === "EOF") return "end of input";
    return t.text;
  }

  // Parse a list of statements. Stops at EOF, at a closing keyword
  // (then/elif/else/fi/do/done), or — when not top level — leaves those for the
  // caller to consume.
  private parseStatements(topLevel: boolean): Script {
    this.enter();
    const statements: Statement[] = [];
    this.skipSeparators();
    while (this.cur.type !== "EOF") {
      if (this.atBlockTerminator()) break;
      const stmt = this.parseStatement();
      statements.push(stmt);
      // A statement must be followed by a separator, a block terminator, or EOF.
      if (this.cur.type === "NEWLINE" || (this.cur.type === "OP" && this.cur.text === ";")) {
        this.skipSeparators();
        continue;
      }
      // background '&' is consumed inside parseStatement; after it a separator
      // is optional.
      if (this.atEnd() || this.atBlockTerminator()) break;
      // Anything else here is a syntax error (e.g. two commands with no sep).
      if (stmt.background) {
        this.skipSeparators();
        continue;
      }
      break;
    }
    this.leave();
    void topLevel;
    return { statements };
  }

  private atEnd(): boolean {
    return this.cur.type === "EOF";
  }

  private atBlockTerminator(): boolean {
    const t = this.cur;
    if (t.type !== "WORD" || t.bare !== true) return false;
    return TERMINATORS.has(t.text);
  }

  private parseStatement(): Statement {
    const andOr = this.parseAndOr();
    let background = false;
    if (this.cur.type === "OP" && this.cur.text === "&") {
      background = true;
      this.advance();
    }
    return { andOr, background };
  }

  private parseAndOr(): AndOr {
    const first = this.parsePipeline();
    const rest: AndOr["rest"] = [];
    for (;;) {
      const t = this.cur;
      if (t.type === "OP" && (t.text === "&&" || t.text === "||")) {
        const op = t.text;
        this.advance();
        this.skipNewlines(); // allow newline after && / ||
        rest.push({ op, pipeline: this.parsePipeline() });
        continue;
      }
      break;
    }
    return { first, rest };
  }

  private parsePipeline(): Pipeline {
    const commands: CommandNode[] = [this.parseCommand()];
    while (this.cur.type === "OP" && this.cur.text === "|") {
      this.advance();
      this.skipNewlines(); // allow newline after |
      commands.push(this.parseCommand());
    }
    return { commands };
  }

  // ---- commands ------------------------------------------------------------

  private parseCommand(): CommandNode {
    this.enter();
    try {
      // Reject explicitly out-of-scope constructs with clear messages first.
      if (this.cur.type === "OP" && this.cur.text === "(") {
        this.error("subshell grouping '( )' is not supported in this shell subset");
      }
      if (this.isKeyword("if")) return this.parseIf();
      if (this.isKeyword("while") || this.isKeyword("until")) return this.parseWhile();
      if (this.isKeyword("for")) return this.parseFor();
      if (this.isKeyword("case")) {
        this.error("'case' is not supported in this shell subset");
      }
      // A bare 'then/do/...' in command position is a syntax error.
      if (this.atBlockTerminator()) {
        this.error(`unexpected keyword '${this.cur.text}'`);
      }
      if (this.isKeyword("else") || this.isKeyword("then") || this.isKeyword("in")) {
        this.error(`unexpected keyword '${this.cur.text}'`);
      }
      return this.parseSimple();
    } finally {
      this.leave();
    }
  }

  private parseSimple(): SimpleCommand {
    const assignments: Assignment[] = [];
    const wordsOut: Word[] = [];
    const redirections: Redirection[] = [];

    // Leading assignments (FOO=bar ...). Stop at first non-assignment word.
    // The value may carry expansions ($VAR, $(...)), so detection inspects the
    // word's first unquoted literal part rather than the reconstructed text
    // (which the lexer only fills for fully-bare words).
    while (this.cur.type === "WORD" && this.assignmentName(this.cur) !== null) {
      assignments.push(this.parseAssignment(this.advance()));
    }

    let sawWord = assignments.length > 0;
    for (;;) {
      const t = this.cur;
      if (t.type === "WORD") {
        // Reject function definition: `name ( )`.
        if (this.toks[this.i + 1]?.type === "OP" && this.toks[this.i + 1]?.text === "(") {
          this.error("shell function definitions ('name() { ... }') are not supported");
        }
        wordsOut.push(this.advance().word as Word);
        sawWord = true;
        continue;
      }
      if (t.type === "REDIR" || t.type === "HEREDOC_OP") {
        redirections.push(this.parseRedirection());
        continue;
      }
      // '(' right after a word would be a function def or subshell.
      if (t.type === "OP" && t.text === "(") {
        this.error("unexpected '(' (subshells and function definitions are not supported)");
      }
      break;
    }

    if (!sawWord && redirections.length === 0) {
      this.error(`expected a command but found '${this.tokenLabel(this.cur)}'`);
    }
    return { kind: "simple", assignments, words: wordsOut, redirections };
  }

  // If `tok` is a WORD whose first part is an unquoted literal of the form
  // NAME=..., return NAME; otherwise null. Quoting the NAME= prefix (e.g.
  // "FOO"=bar) defeats assignment detection, matching bash.
  private assignmentName(tok: Token): string | null {
    const first = tok.word?.[0];
    if (!first || first.kind !== "literal" || first.quoted) return null;
    const m = ASSIGN_RE.exec(first.text);
    if (!m) return null;
    return first.text.slice(0, first.text.indexOf("="));
  }

  private parseAssignment(tok: Token): Assignment {
    const name = this.assignmentName(tok);
    if (name === null) this.error("internal: parseAssignment on non-assignment word");
    // Build the value Word by dropping the leading "NAME=" from the first part.
    // Subsequent parts (expansions, more literals) are the rest of the value.
    const parts = (tok.word ?? []).slice();
    const first = parts[0];
    if (first && first.kind === "literal") {
      const rest = first.text.slice(first.text.indexOf("=") + 1);
      if (rest.length > 0) parts[0] = { ...first, text: rest };
      else parts.shift();
    }
    const value: Word = parts.length > 0 ? parts : [{ kind: "literal", text: "", quoted: true }];
    return { name, value };
  }

  private parseRedirection(): Redirection {
    const t = this.advance();
    if (t.type === "HEREDOC_OP") {
      const hd = t.heredoc;
      if (!hd) this.error("internal: heredoc operator without body");
      return {
        fd: 0,
        op: "heredoc",
        target: null,
        heredoc: { body: t.text, expand: !hd.quoted },
      };
    }
    // REDIR token.
    if (t.text === "2>&1") {
      return { fd: 2, op: "2>&1", target: null };
    }
    let fd: 0 | 1 | 2;
    let op: ">" | ">>" | "<";
    switch (t.text) {
      case ">":
        fd = 1;
        op = ">";
        break;
      case ">>":
        fd = 1;
        op = ">>";
        break;
      case "<":
        fd = 0;
        op = "<";
        break;
      case "1>":
        fd = 1;
        op = ">";
        break;
      case "1>>":
        fd = 1;
        op = ">>";
        break;
      case "0<":
        fd = 0;
        op = "<";
        break;
      case "2>":
        fd = 2;
        op = ">";
        break;
      case "2>>":
        fd = 2;
        op = ">>";
        break;
      default:
        this.error(`unsupported redirection '${t.text}'`);
    }
    // A redirection requires a target word.
    if (this.cur.type !== "WORD") {
      this.error(`expected filename after redirection '${t.text}'`);
    }
    const target = this.advance().word as Word;
    return { fd, op, target };
  }

  // Parse redirections that may trail a compound command (e.g. `done > out`).
  private parseTrailingRedirections(): Redirection[] {
    const out: Redirection[] = [];
    while (this.cur.type === "REDIR" || this.cur.type === "HEREDOC_OP") {
      out.push(this.parseRedirection());
    }
    return out;
  }

  // ---- control flow --------------------------------------------------------

  private expectKeyword(kw: string): void {
    if (!this.isKeyword(kw)) {
      this.error(`expected '${kw}' but found '${this.tokenLabel(this.cur)}'`);
    }
    this.advance();
  }

  private parseIf(): IfNode {
    this.advance(); // 'if'
    const clauses: IfClause[] = [];
    // condition list until 'then'
    const cond = this.parseStatements(false);
    this.skipSeparators();
    this.expectKeyword("then");
    const body = this.parseStatements(false);
    clauses.push({ cond, body });

    this.skipSeparators();
    while (this.isKeyword("elif")) {
      this.advance();
      const econd = this.parseStatements(false);
      this.skipSeparators();
      this.expectKeyword("then");
      const ebody = this.parseStatements(false);
      clauses.push({ cond: econd, body: ebody });
      this.skipSeparators();
    }

    let elseBody: Script | null = null;
    if (this.isKeyword("else")) {
      this.advance();
      elseBody = this.parseStatements(false);
      this.skipSeparators();
    }
    this.expectKeyword("fi");
    const redirections = this.parseTrailingRedirections();
    return { kind: "if", clauses, elseBody, redirections };
  }

  private parseWhile(): WhileNode {
    this.advance(); // 'while' or 'until'
    const cond = this.parseStatements(false);
    this.skipSeparators();
    this.expectKeyword("do");
    const body = this.parseStatements(false);
    this.skipSeparators();
    this.expectKeyword("done");
    const redirections = this.parseTrailingRedirections();
    return { kind: "while", cond, body, redirections };
  }

  private parseFor(): ForNode {
    this.advance(); // 'for'
    if (this.cur.type !== "WORD" || this.cur.bare !== true || !NAME_RE.test(this.cur.text)) {
      this.error(`expected loop variable name after 'for' but found '${this.tokenLabel(this.cur)}'`);
    }
    const varName = this.advance().text;
    const items: Word[] = [];
    // 'in <words>' is optional in bash (defaults to "$@"); we require explicit
    // 'in' for clarity in this subset but allow an empty item list.
    if (this.isKeyword("in")) {
      this.advance();
      while (this.cur.type === "WORD" && !this.atBlockTerminator()) {
        items.push(this.advance().word as Word);
      }
    } else {
      this.error("'for NAME in <words>; do ...; done' is required ('for NAME' shorthand unsupported)");
    }
    this.skipSeparators();
    this.expectKeyword("do");
    const body = this.parseStatements(false);
    this.skipSeparators();
    this.expectKeyword("done");
    const redirections = this.parseTrailingRedirections();
    return { kind: "for", varName, items, body, redirections };
  }
}

export function parse(src: string): Script {
  const toks = tokenize(src);
  return new Parser(toks).parseScript();
}
