import { isMap, isScalar, LineCounter, parseDocument, visit } from "yaml";

import { splitLines } from "./text.ts";

/** YAML frontmatter at the start of a Markdown file. */
export interface Frontmatter {
  /** YAML source lines between the `---` delimiters. */
  lines: string[];
  /** 1-based file line of `lines[0]`. */
  firstLine: number;
  /** Whether the closing `---` was found. */
  closed: boolean;
}

/** Common causes of YAML errors in frontmatter values. */
export type YamlMistake = "tab" | "colon" | "flow" | "reserved" | "other";

export type ParsedFrontmatter =
  | { ok: true; data: unknown; keyLines: Map<string, number>; duplicates: { key?: string; line: number }[] }
  /** `line` is the 1-based file line where parsing fails. */
  | { ok: false; line: number; mistake: YamlMistake; help: string };

const DELIMITER = /^---[ \t]*$/;

/** Whether a line opens or closes a frontmatter block. */
export function isFrontmatterDelimiter(line: string): boolean {
  return DELIMITER.test(line);
}

/** Extracts the frontmatter block, or returns null when the file doesn't start with `---`. */
export function extractFrontmatter(text: string | readonly string[]): Frontmatter | null {
  const lines = typeof text === "string" ? splitLines(text) : text;
  if (!isFrontmatterDelimiter(lines[0] ?? "")) return null;
  const end = lines.findIndex((line, i) => i > 0 && isFrontmatterDelimiter(line));
  return end === -1
    ? { lines: lines.slice(1), firstLine: 2, closed: false }
    : { lines: lines.slice(1, end), firstLine: 2, closed: true };
}

/** Classifies the YAML mistake on a failing line. */
function classify(line: string): { mistake: YamlMistake; help: string } {
  if (/\t/.test(line.match(/^\s*/)?.[0] ?? "")) {
    return { mistake: "tab", help: "YAML does not allow tabs for indentation." };
  }
  const value = /^\s*(?:- )?[\w.-]+:[ \t]+(.*)$/.exec(line)?.[1]?.trim() ?? "";
  if (/^[[{]/.test(value)) {
    return {
      mistake: "flow",
      help: 'Quote the value (`key: "…"`): an unquoted value starting with `[` or `{` is read as a YAML list or mapping.',
    };
  }
  if (value && !/^["'|>]/.test(value)) {
    if (/:\s|:$/.test(value)) {
      return {
        mistake: "colon",
        help: 'Quote the value (`key: "…"`): a `: ` inside an unquoted value starts a nested mapping.',
      };
    }
    if (/^[@`]/.test(value)) {
      return {
        mistake: "reserved",
        help: 'Quote the value (`key: "…"`): YAML reserves `@` and `` ` `` at the start of a value.',
      };
    }
  }
  return {
    mistake: "other",
    help: "Fix the YAML syntax. Quote values that contain special characters such as `: `, ` #` or a leading `@`.",
  };
}

/** Parses YAML with positions for syntax errors, mapping keys and duplicates. */
export function parseFrontmatter(frontmatter: Frontmatter): ParsedFrontmatter {
  const { lines, firstLine } = frontmatter;
  const lineCounter = new LineCounter();
  const document = parseDocument(lines.join("\n"), { lineCounter, prettyErrors: false });
  const lineOf = (offset: number) => firstLine + lineCounter.linePos(offset).line - 1;
  const syntaxError = document.errors.find((error) => error.code !== "DUPLICATE_KEY");
  if (syntaxError) {
    const line = lineOf(syntaxError.pos[0]);
    return { ok: false, line, ...classify(lines[line - firstLine] ?? "") };
  }

  const keyLines = new Map<string, number>();
  if (isMap(document.contents)) {
    for (const { key } of document.contents.items) {
      if (isScalar(key) && typeof key.value === "string" && key.range && !keyLines.has(key.value)) {
        keyLines.set(key.value, lineOf(key.range[0]));
      }
    }
  }
  const duplicateKeys = new Map<number, string | undefined>(document.errors.map(({ pos }) => [pos[0], undefined]));
  if (duplicateKeys.size) {
    visit(document, {
      Pair(_, { key }) {
        if (isScalar(key) && typeof key.value === "string" && key.range && duplicateKeys.has(key.range[0])) {
          duplicateKeys.set(key.range[0], key.value);
        }
      },
    });
  }
  try {
    const data: unknown = document.toJS();
    const duplicates = Array.from(duplicateKeys, ([offset, key]) => ({ key, line: lineOf(offset) }));
    return { ok: true, data, keyLines, duplicates };
  } catch {
    return { ok: false, line: firstLine, ...classify(lines[0] ?? "") };
  }
}
