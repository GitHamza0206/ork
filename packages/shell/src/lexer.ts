// Tokenizer for the @ork.ai/shell bash subset.
//
// The lexer produces a flat token stream. WORD tokens carry an already-parsed
// Word (array of WordPart) so the parser never has to re-scan quoting. Operator
// and separator tokens carry their literal text. Heredoc bodies are collected
// after the logical line that introduced them, exactly like bash.

import { ShellParseError } from "./errors.js";
import type { Word, WordPart } from "./ast.js";

export type TokenType =
  | "WORD"
  | "OP" // | || && ; & ( )
  | "REDIR" // > >> < 2> 2>> 2>&1
  | "NEWLINE"
  | "HEREDOC_OP" // << or <<- (target captured separately)
  | "EOF";

export interface Token {
  type: TokenType;
  // For WORD: the literal text reconstructed for reserved-word matching.
  // For OP/REDIR/NEWLINE: the operator text.
  text: string;
  line: number;
  // For WORD tokens only: the structured word.
  word?: Word;
  // For WORD tokens: true if the whole word was a single unquoted bare token
  // (used to detect reserved words & assignment / for-name syntax).
  bare?: boolean;
  // For HEREDOC_OP tokens: the parsed delimiter and whether it was quoted.
  heredoc?: { delimiter: string; quoted: boolean; stripTabs: boolean };
}

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TOKENS = 8192;

// Operators sorted so the lexer can do a longest-match scan.
// 2>&1 / 2>> / 2> are handled specially because they begin with a digit fd.

interface PendingHeredoc {
  token: Token;
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

class Lexer {
  private pos = 0;
  private line = 1;
  private readonly len: number;
  private readonly tokens: Token[] = [];
  private pendingHeredocs: PendingHeredoc[] = [];

  constructor(private readonly src: string) {
    this.len = src.length;
  }

  private error(message: string): never {
    throw new ShellParseError(message, this.line);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private push(t: Token): void {
    this.tokens.push(t);
    if (this.tokens.length > MAX_TOKENS) {
      this.error(`token limit exceeded (max ${MAX_TOKENS})`);
    }
  }

  tokenize(): Token[] {
    if (Buffer.byteLength(this.src, "utf8") > MAX_INPUT_BYTES) {
      this.error(`input too large (max ${MAX_INPUT_BYTES} bytes)`);
    }

    while (this.pos < this.len) {
      const c = this.peek();

      // Blank (non-newline) whitespace separates tokens.
      if (c === " " || c === "\t") {
        this.pos++;
        continue;
      }

      // Line continuation: backslash-newline is removed.
      if (c === "\\" && this.peek(1) === "\n") {
        this.pos += 2;
        this.line++;
        continue;
      }

      if (c === "\n") {
        this.pos++;
        this.emitNewline();
        continue;
      }

      // Comment: # to end of line, only at the start of a token.
      if (c === "#" && this.atTokenStart()) {
        while (this.pos < this.len && this.peek() !== "\n") this.pos++;
        continue;
      }

      // Operators & redirections.
      if (this.tryOperator()) continue;

      // Otherwise, a word.
      this.readWord();
    }

    this.emitNewline(); // flush any trailing heredocs on final implicit newline
    this.push({ type: "EOF", text: "", line: this.line });
    return this.tokens;
  }

  // '#' starts a comment only when it is at the start of a word, i.e. the
  // preceding source character is whitespace/newline or start of input (mid-word
  // '#', as in a#b, is literal — bash behaves the same).
  private atTokenStart(): boolean {
    if (this.pos === 0) return true;
    const prevChar = this.src[this.pos - 1];
    return prevChar === " " || prevChar === "\t" || prevChar === "\n";
  }

  private emitNewline(): void {
    // Collect any heredoc bodies queued from operators on the line just ended.
    if (this.pendingHeredocs.length > 0) {
      for (const h of this.pendingHeredocs) {
        h.token.heredoc = {
          delimiter: h.delimiter,
          quoted: h.quoted,
          stripTabs: h.stripTabs,
        };
        h.token.text = this.readHeredocBody(h);
      }
      this.pendingHeredocs = [];
    }
    // Only emit a NEWLINE token if it carries meaning (avoid leading blank lines).
    const prev = this.tokens[this.tokens.length - 1];
    if (prev && prev.type !== "NEWLINE") {
      this.push({ type: "NEWLINE", text: "\n", line: this.line });
    }
    this.line++;
  }

  private readHeredocBody(h: PendingHeredoc): string {
    const lines: string[] = [];
    for (;;) {
      if (this.pos >= this.len) {
        this.error(`unterminated heredoc (expected '${h.delimiter}')`);
      }
      // Read one physical line (without the newline).
      let start = this.pos;
      while (this.pos < this.len && this.peek() !== "\n") this.pos++;
      let lineText = this.src.slice(start, this.pos);
      if (this.pos < this.len) this.pos++; // consume newline
      this.line++;

      let compare = lineText;
      if (h.stripTabs) {
        compare = compare.replace(/^\t+/, "");
        lineText = lineText.replace(/^\t+/, "");
      }
      if (compare === h.delimiter) {
        break;
      }
      lines.push(lineText);
    }
    // Body keeps a trailing newline per line, matching bash heredoc semantics.
    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  private tryOperator(): boolean {
    const c = this.peek();

    // Heredoc << / <<- (must come before single '<').
    if (c === "<" && this.peek(1) === "<") {
      const stripTabs = this.peek(2) === "-";
      const opLen = stripTabs ? 3 : 2;
      const startLine = this.line;
      this.pos += opLen;
      // Skip blanks before the delimiter.
      while (this.peek() === " " || this.peek() === "\t") this.pos++;
      const { delimiter, quoted } = this.readHeredocDelimiter();
      const tok: Token = { type: "HEREDOC_OP", text: "<<", line: startLine };
      this.push(tok);
      this.pendingHeredocs.push({ token: tok, delimiter, quoted, stripTabs });
      return true;
    }

    // fd-prefixed redirections: 2>&1, 2>>, 2>, and 1>, 0<, etc.
    if ((c === "0" || c === "1" || c === "2") && (this.peek(1) === ">" || this.peek(1) === "<")) {
      const fd = c;
      const next = this.peek(1);
      if (fd === "2" && next === ">" && this.peek(2) === "&" && this.peek(3) === "1") {
        this.push({ type: "REDIR", text: "2>&1", line: this.line });
        this.pos += 4;
        return true;
      }
      if (next === ">" && this.peek(2) === ">") {
        this.push({ type: "REDIR", text: `${fd}>>`, line: this.line });
        this.pos += 3;
        return true;
      }
      if (next === ">") {
        this.push({ type: "REDIR", text: `${fd}>`, line: this.line });
        this.pos += 2;
        return true;
      }
      if (next === "<") {
        this.push({ type: "REDIR", text: `${fd}<`, line: this.line });
        this.pos += 2;
        return true;
      }
    }

    // Plain redirections >> > <
    if (c === ">") {
      if (this.peek(1) === ">") {
        this.push({ type: "REDIR", text: ">>", line: this.line });
        this.pos += 2;
      } else {
        this.push({ type: "REDIR", text: ">", line: this.line });
        this.pos += 1;
      }
      return true;
    }
    if (c === "<") {
      this.push({ type: "REDIR", text: "<", line: this.line });
      this.pos += 1;
      return true;
    }

    // Control operators (longest match: && before &, || before |).
    if (c === "&") {
      if (this.peek(1) === "&") {
        this.push({ type: "OP", text: "&&", line: this.line });
        this.pos += 2;
      } else {
        this.push({ type: "OP", text: "&", line: this.line });
        this.pos += 1;
      }
      return true;
    }
    if (c === "|") {
      if (this.peek(1) === "|") {
        this.push({ type: "OP", text: "||", line: this.line });
        this.pos += 2;
      } else {
        this.push({ type: "OP", text: "|", line: this.line });
        this.pos += 1;
      }
      return true;
    }
    if (c === ";") {
      // ;; is reserved for case (out of scope) — surface a clear error.
      if (this.peek(1) === ";") {
        this.error("';;' (case syntax) is not supported in this shell subset");
      }
      this.push({ type: "OP", text: ";", line: this.line });
      this.pos += 1;
      return true;
    }
    if (c === "(") {
      this.push({ type: "OP", text: "(", line: this.line });
      this.pos += 1;
      return true;
    }
    if (c === ")") {
      this.push({ type: "OP", text: ")", line: this.line });
      this.pos += 1;
      return true;
    }

    return false;
  }

  private readHeredocDelimiter(): { delimiter: string; quoted: boolean } {
    const c = this.peek();
    if (c === "'" || c === '"') {
      this.pos++; // opening quote
      let out = "";
      while (this.pos < this.len && this.peek() !== c) {
        out += this.peek();
        this.pos++;
      }
      if (this.peek() !== c) this.error("unterminated heredoc delimiter quote");
      this.pos++; // closing quote
      return { delimiter: out, quoted: true };
    }
    // Unquoted delimiter: read until whitespace/newline/operator.
    let out = "";
    while (this.pos < this.len) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "&" || ch === "|") break;
      if (ch === "\\") {
        out += this.peek(1);
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos++;
    }
    if (out.length === 0) this.error("missing heredoc delimiter after '<<'");
    return { delimiter: out, quoted: false };
  }

  // Read one WORD token, processing quoting and $-expansions into WordParts.
  private readWord(): void {
    const startLine = this.line;
    const parts: WordPart[] = [];
    let bare = true; // becomes false the moment we hit any quote or expansion
    let literal = ""; // accumulating unquoted literal run

    const flushLiteral = (): void => {
      if (literal.length > 0) {
        parts.push({ kind: "literal", text: literal, quoted: false });
        literal = "";
      }
    };

    loop: while (this.pos < this.len) {
      const c = this.peek();

      // Word terminators (unquoted).
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === ";" ||
        c === "&" ||
        c === "|" ||
        c === "<" ||
        c === ">" ||
        c === "(" ||
        c === ")"
      ) {
        break loop;
      }

      // A digit immediately followed by a redirection char (e.g. `2>`) only
      // terminates a word when it is the entire word so far; mid-word it is a
      // literal. We keep it simple: if literal/parts already have content the
      // fd-redir is part of the word per bash (rare), so just treat normally.

      if (c === "\\") {
        const next = this.peek(1);
        if (next === "\n") {
          // line continuation inside a word
          this.pos += 2;
          this.line++;
          continue;
        }
        if (next === "") this.error("trailing backslash");
        bare = false;
        literal += next;
        this.pos += 2;
        continue;
      }

      if (c === "'") {
        bare = false;
        this.pos++; // opening
        let start = this.pos;
        while (this.pos < this.len && this.peek() !== "'") {
          if (this.peek() === "\n") this.line++;
          this.pos++;
        }
        if (this.peek() !== "'") this.error("unterminated single quote");
        flushLiteral();
        parts.push({ kind: "literal", text: this.src.slice(start, this.pos), quoted: true });
        this.pos++; // closing
        continue;
      }

      if (c === '"') {
        bare = false;
        this.pos++; // opening
        flushLiteral();
        this.readDoubleQuoted(parts);
        continue;
      }

      if (c === "$") {
        const part = this.tryReadExpansion(false);
        if (part) {
          bare = false;
          flushLiteral();
          parts.push(part);
          continue;
        }
        // Lone '$' not starting a valid expansion: literal dollar.
        literal += "$";
        this.pos++;
        continue;
      }

      // Backtick command substitution is intentionally rejected (use $()).
      if (c === "`") {
        this.error("backtick command substitution is not supported; use $( ... )");
      }

      // Ordinary character (includes glob metachars *, ?, [, ] which survive).
      literal += c;
      this.pos++;
    }

    flushLiteral();

    // An empty word can arise from e.g. `""` — represent as a single empty
    // quoted literal so it is still a distinct argument.
    if (parts.length === 0) {
      parts.push({ kind: "literal", text: "", quoted: true });
      bare = false;
    }

    // Reconstruct text for reserved-word/assignment matching: only meaningful
    // when the word is a single unquoted literal.
    const text = bare && parts.length === 1 && parts[0]?.kind === "literal" ? parts[0].text : "";

    this.push({ type: "WORD", text, line: startLine, word: parts, bare });
  }

  // Inside double quotes: literals are quoted; $VAR/${VAR}/$(...) still parse,
  // but variables become var-quoted and cmdsub keeps quoted=true.
  private readDoubleQuoted(parts: WordPart[]): void {
    let buf = "";
    const flush = (): void => {
      if (buf.length > 0) {
        parts.push({ kind: "literal", text: buf, quoted: true });
        buf = "";
      }
    };
    while (this.pos < this.len) {
      const c = this.peek();
      if (c === '"') {
        this.pos++; // closing quote
        flush();
        return;
      }
      if (c === "\\") {
        const next = this.peek(1);
        // In double quotes, backslash only escapes $ ` " \ and newline.
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          buf += next;
          this.pos += 2;
          continue;
        }
        if (next === "\n") {
          this.pos += 2;
          this.line++;
          continue;
        }
        // Otherwise the backslash is literal.
        buf += "\\";
        this.pos++;
        continue;
      }
      if (c === "$") {
        const part = this.tryReadExpansion(true);
        if (part) {
          flush();
          parts.push(part);
          continue;
        }
        buf += "$";
        this.pos++;
        continue;
      }
      if (c === "`") {
        this.error("backtick command substitution is not supported; use $( ... )");
      }
      if (c === "\n") this.line++;
      buf += c;
      this.pos++;
    }
    this.error("unterminated double quote");
  }

  // Attempt to read a $-expansion at the current position. Returns null if the
  // '$' does not begin a recognized expansion (caller treats it as literal).
  private tryReadExpansion(inDouble: boolean): WordPart | null {
    // assumes peek() === '$'
    const next = this.peek(1);

    // $(( ... )) arithmetic is out of scope.
    if (next === "(" && this.peek(2) === "(") {
      this.error("arithmetic expansion $(( )) is not supported in this shell subset");
    }

    // $( ... ) command substitution.
    if (next === "(") {
      this.pos += 2; // consume "$("
      const script = this.readCmdSubBody();
      return { kind: "cmdsub", script, quoted: inDouble };
    }

    // ${ ... } — plain ${VAR} only; reject operators.
    if (next === "{") {
      this.pos += 2; // consume "${"
      let name = "";
      while (this.pos < this.len) {
        const ch = this.peek();
        if (ch === "}") break;
        if (/[A-Za-z0-9_]/.test(ch)) {
          name += ch;
          this.pos++;
          continue;
        }
        // Any other char => parameter-expansion operator, out of scope.
        this.error(
          `parameter expansion operator '${ch}' in \${...} is not supported in this shell subset`,
        );
      }
      if (this.peek() !== "}") this.error("unterminated '${'");
      this.pos++; // consume '}'
      if (name.length === 0) this.error("empty '${}' is not valid");
      return inDouble ? { kind: "var-quoted", name } : { kind: "var", name };
    }

    // $NAME — letters, digits, underscore (must start with letter/underscore).
    if (/[A-Za-z_]/.test(next)) {
      this.pos++; // consume '$'
      let name = "";
      while (this.pos < this.len && /[A-Za-z0-9_]/.test(this.peek())) {
        name += this.peek();
        this.pos++;
      }
      return inDouble ? { kind: "var-quoted", name } : { kind: "var", name };
    }

    // Special single-char params ($?, $$, $!, $#, $@, $*, $0-$9) — keep the
    // name as the single character so the interpreter can resolve it.
    if ("?$!#@*0123456789".includes(next)) {
      this.pos += 2; // consume '$' and the char
      return inDouble ? { kind: "var-quoted", name: next } : { kind: "var", name: next };
    }

    return null;
  }

  // Read the raw inner text of a $( ... ), tracking paren depth and honoring
  // quotes/escapes so that parens inside strings don't end the substitution.
  private readCmdSubBody(): string {
    let depth = 1;
    let out = "";
    while (this.pos < this.len) {
      const c = this.peek();
      if (c === "\\") {
        out += c + this.peek(1);
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        // single-quoted span: copy verbatim until closing quote
        out += c;
        this.pos++;
        while (this.pos < this.len && this.peek() !== "'") {
          if (this.peek() === "\n") this.line++;
          out += this.peek();
          this.pos++;
        }
        if (this.peek() !== "'") this.error("unterminated single quote in command substitution");
        out += "'";
        this.pos++;
        continue;
      }
      if (c === '"') {
        out += c;
        this.pos++;
        while (this.pos < this.len) {
          const d = this.peek();
          if (d === "\\") {
            out += d + this.peek(1);
            this.pos += 2;
            continue;
          }
          if (d === '"') break;
          if (d === "\n") this.line++;
          out += d;
          this.pos++;
        }
        if (this.peek() !== '"') this.error("unterminated double quote in command substitution");
        out += '"';
        this.pos++;
        continue;
      }
      if (c === "(") {
        depth++;
        out += c;
        this.pos++;
        continue;
      }
      if (c === ")") {
        depth--;
        this.pos++;
        if (depth === 0) return out;
        out += c;
        continue;
      }
      if (c === "\n") this.line++;
      out += c;
      this.pos++;
    }
    this.error("unterminated command substitution '$('");
  }
}

export function tokenize(src: string): Token[] {
  return new Lexer(src).tokenize();
}
