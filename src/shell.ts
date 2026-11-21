/**
 * Minimal shell parsing: just enough to find package-manager invocations in
 * documentation (`pnpm dev`, `cd web && npm run build`, ...).
 */

export interface Token {
  value: string;
  /** Offset of the first character of the value in the segment string. */
  offset: number;
  /** Source offsets when quoting or escapes made the value non-contiguous. */
  sourceOffsets?: number[];
}

export function sliceToken(token: Token, start: number, end?: number): Token {
  const sourceOffsets = token.sourceOffsets?.slice(start, end);
  return {
    value: token.value.slice(start, end),
    offset: sourceOffsets?.[0] ?? token.offset + start,
    sourceOffsets,
  };
}

export function tokenEndOffset(token: Token): number {
  const last = token.sourceOffsets?.at(-1);
  return last === undefined ? token.offset + token.value.length : last + 1;
}

export interface Segment {
  text: string;
  /** Offset of the segment within the line. */
  offset: number;
  subshell?: "open" | "close";
  pipeToNext?: boolean;
}

/** Splits a command line on unquoted shell operators and keeps subshell boundaries. */
export function splitSegments(line: string, openSubshells = 0): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let quote: string | null = null;
  // Parentheses attached to an expression, such as `$(...)`, do not open a command group.
  let expressionDepth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\" && quote !== "'") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      // Comment: the rest of the line is ignored.
      segments.push({ text: line.slice(start, i), offset: start });
      return segments.filter((s) => s.text.trim());
    }
    if (ch === "(" && (expressionDepth || line[i + 1] === "(" || line.slice(start, i).trim())) {
      expressionDepth++;
      continue;
    }
    if (expressionDepth) {
      if (ch === ")") expressionDepth--;
      continue;
    }
    if (ch === "(" || (ch === ")" && openSubshells > 0)) {
      segments.push({ text: line.slice(start, i), offset: start });
      segments.push({ text: ch, offset: i, subshell: ch === "(" ? "open" : "close" });
      openSubshells += ch === "(" ? 1 : -1;
      start = i + 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      // Don't split redirections like `2>&1` or `&>`.
      if (ch === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) continue;
      const next = line[i + 1];
      const text = line.slice(start, i);
      if (ch === "|" && next !== "|") {
        const previous = segments.at(-1);
        if (!text.trim() && previous?.subshell === "close") previous.pipeToNext = true;
        else segments.push({ text, offset: start, pipeToNext: true });
      } else {
        segments.push({ text, offset: start });
      }
      if (((ch === "&" || ch === "|") && next === ch) || (ch === "|" && next === "&")) i++;
      start = i + 1;
    }
  }
  segments.push({ text: line.slice(start), offset: start });
  return segments.filter((s) => s.text.trim());
}

/**
 * Tokenizes a single simple command. Returns null for commands that can't be
 * analysed statically (command substitution, unbalanced quotes).
 */
export function tokenize(segment: string): Token[] | null {
  if (segment.includes("$(") || segment.includes("`")) return null;
  const tokens: Token[] = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i] as string)) i++;
    if (i >= segment.length) break;
    let value = "";
    const sourceOffsets: number[] = [];
    while (i < segment.length && !/\s/.test(segment[i] as string)) {
      const ch = segment[i] as string;
      if (ch === "'" || ch === '"') {
        const end = segment.indexOf(ch, i + 1);
        if (end === -1) return null;
        value += segment.slice(i + 1, end);
        for (let j = i + 1; j < end; j++) sourceOffsets.push(j);
        i = end + 1;
      } else if (ch === "\\" && i + 1 < segment.length) {
        value += segment[i + 1];
        sourceOffsets.push(i + 1);
        i += 2;
      } else {
        value += ch;
        sourceOffsets.push(i);
        i++;
      }
    }
    const offset = sourceOffsets[0];
    if (offset !== undefined) {
      const contiguous = sourceOffsets.at(-1) === offset + value.length - 1;
      tokens.push({ value, offset, sourceOffsets: contiguous ? undefined : sourceOffsets });
    }
  }
  // Strip redirections.
  const cleaned: Token[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t] as Token;
    const { value } = token;
    if (!value) continue;
    if (/^\d*[<>]/.test(value)) {
      // `> file` / `2>&1` / `>file`: drop the redirection (and its target if separate).
      if (/^\d*[<>]+&?$/.test(value)) t++;
      continue;
    }
    cleaned.push(token);
  }
  return cleaned;
}

const COMMAND_WRAPPERS = new Set(["sudo", "time", "nice", "nohup", "exec", "command", "builtin", "env", "corepack"]);

/** Removes leading `FOO=bar` assignments and wrappers like `sudo`, `time`, `env` or `corepack`. */
export function stripCommandPrefix(tokens: Token[]): Token[] {
  let i = 0;
  while (i < tokens.length) {
    const value = (tokens[i] as Token).value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      i++;
    } else if (COMMAND_WRAPPERS.has(value)) {
      i++;
      while (tokens[i]?.value.startsWith("-")) i++;
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

const SHELL_LANGS = new Set([
  "",
  "sh",
  "bash",
  "shell",
  "zsh",
  "fish",
  "console",
  "terminal",
  "shellsession",
  "sh-session",
  "shell-session",
  "ps1",
  "powershell",
  "pwsh",
  "cmd",
  "bat",
  "batch",
  "nu",
  "nushell",
  "text",
  "txt",
  "plaintext",
]);

const SESSION_LANGS = new Set(["console", "terminal", "shellsession", "sh-session", "shell-session"]);

export function isShellLang(lang: string | null | undefined): boolean {
  return SHELL_LANGS.has((lang ?? "").toLowerCase());
}

interface CommandPart {
  lineIndex: number;
  column: number;
  offset: number;
}

/**
 * Splits a shell code block into logical command lines: joins `\` line
 * continuations, strips prompts (`$ `), and — for session transcripts — skips
 * output lines. Each part preserves its position in the original code block.
 */
export function codeBlockCommandLines(
  code: string,
  lang: string | null | undefined,
): { text: string; parts: CommandPart[] }[] {
  const session = SESSION_LANGS.has((lang ?? "").toLowerCase());
  const raw = code.split(/\r?\n/);
  const out: { text: string; parts: CommandPart[] }[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i] as string;
    const prompt = /^\s*(?:[$%❯]|PS>|[\w.-]+@[\w.-]+:?[^$#\s]*[$#])\s+/.exec(line);
    if (session && !prompt) continue;
    const column = prompt?.[0].length ?? 0;
    line = line.slice(column);
    const parts: CommandPart[] = [{ lineIndex: i, column, offset: 0 }];
    while (line.endsWith("\\") && i + 1 < raw.length) {
      i++;
      const continuation = raw[i] as string;
      const trimmed = continuation.trimStart();
      parts.push({ lineIndex: i, column: continuation.length - trimmed.length, offset: line.length });
      line = `${line.slice(0, -1)} ${trimmed}`;
    }
    if (line.trim()) out.push({ text: line, parts });
  }
  return out;
}
