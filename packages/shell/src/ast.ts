// AST types for the @ork.ai/shell bash-subset parser.
//
// A Word is a sequence of WordPart fragments. Expansions ($VAR, ${VAR}, $(...))
// are kept as structured parts and are NOT resolved at parse time — the
// interpreter resolves them later. Globs (*, ?, [...]) survive as literal
// characters in unquoted parts; the interpreter performs expansion.

export type WordPart =
  // literal text; quoted=true means it came from quotes (no glob, no field-split)
  | { kind: "literal"; text: string; quoted: boolean }
  // $VAR / ${VAR} encountered in unquoted context
  | { kind: "var"; name: string }
  // $VAR / ${VAR} encountered inside double quotes (no field-split on result)
  | { kind: "var-quoted"; name: string }
  // $( ... ) command substitution; script is the RAW inner text
  | { kind: "cmdsub"; script: string; quoted: boolean };

export type Word = WordPart[];

export interface Assignment {
  name: string;
  value: Word;
}

export type RedirOp = ">" | ">>" | "<" | "2>&1" | "heredoc";

export interface Redirection {
  // file descriptor affected by this redirection
  fd: 0 | 1 | 2;
  op: RedirOp;
  // target word for file redirections; null for "2>&1" and heredoc
  target: Word | null;
  // present only when op === "heredoc"
  heredoc?: { body: string; expand: boolean };
}

export interface SimpleCommand {
  kind: "simple";
  assignments: Assignment[];
  words: Word[];
  redirections: Redirection[];
}

export interface IfClause {
  cond: Script;
  body: Script;
}

export interface IfNode {
  kind: "if";
  // first clause is the `if`, subsequent are `elif`
  clauses: IfClause[];
  elseBody: Script | null;
  redirections: Redirection[];
}

export interface WhileNode {
  kind: "while";
  cond: Script;
  body: Script;
  redirections: Redirection[];
}

export interface ForNode {
  kind: "for";
  varName: string;
  items: Word[];
  body: Script;
  redirections: Redirection[];
}

export type CommandNode = SimpleCommand | IfNode | WhileNode | ForNode;

export interface Pipeline {
  // length 1 = no pipe
  commands: CommandNode[];
}

export interface AndOr {
  first: Pipeline;
  rest: Array<{ op: "&&" | "||"; pipeline: Pipeline }>;
}

export interface Statement {
  andOr: AndOr;
  background: boolean;
}

export interface Script {
  statements: Statement[];
}
