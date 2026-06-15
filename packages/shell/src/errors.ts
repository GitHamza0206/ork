// Error thrown by the lexer and parser of @ork.ai/shell for any syntax that is
// malformed or outside the supported v1 subset.
export class ShellParseError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
    this.name = "ShellParseError";
  }
}

// Error thrown at runtime by the interpreter (e.g. ambiguous redirect, cmdsub
// depth exceeded, unimplemented compound command). Distinct from parse errors.
export class ShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellError";
  }
}
