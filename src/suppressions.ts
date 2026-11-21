import { CST, Lexer } from "yaml";

import { resolveRuleName, suggestRuleName } from "#src/rules/index.ts";

import { extractFrontmatter } from "./frontmatter.ts";
import { visit } from "./markdown.ts";
import { splitLines } from "./text.ts";
import type { Diagnostic, LintedFile, Position } from "./types.ts";

type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

export interface Directive {
  kind: DirectiveKind;
  /** Rule names, or null for all rules. */
  rules: Set<string> | null;
  line: number;
  endLine: number;
  /** Names that are not rules (most likely typos), which suppress nothing. */
  unknownRules: UnknownRule[];
}

export interface UnknownRule {
  name: string;
  start: Position;
  end: Position;
}

const DIRECTIVE_RE = /<!--\s*contextlint-(disable-next-line|disable-line|disable|enable)\b([\s\S]*?)-->/g;
/** The same directives as YAML comments in frontmatter: `# contextlint-disable-next-line rule`. */
const COMMENT_DIRECTIVE_RE = /^#\s*contextlint-(disable-next-line|disable-line|disable|enable)\b(.*)$/;

/** YAML comments with their 0-based line in `source`. Text in scalars and quoted strings is skipped. */
function yamlComments(source: string): { text: string; line: number }[] {
  const comments: { text: string; line: number }[] = [];
  let line = 0;
  for (const token of new Lexer().lex(source)) {
    if (CST.tokenType(token) === "comment") comments.push({ text: token, line });
    line += token.split("\n").length - 1;
  }
  return comments;
}

interface ParsedRules {
  /** Rule names, or null for all rules. */
  rules: Set<string> | null;
  /** Names that are not rules, with their offset in the parsed text. */
  unknown: { name: string; index: number }[];
}

/** Rule names of a directive (before an optional `-- reason`). */
function parseRules(text: string): ParsedRules {
  const list = text.split(/\s--\s|^--\s/)[0] ?? "";
  if (!list.trim()) return { rules: null, unknown: [] };
  const rules = new Set<string>();
  const unknown: ParsedRules["unknown"] = [];
  for (const { 0: name, index } of list.matchAll(/[^\s,]+/g)) {
    const rule = resolveRuleName(name);
    rules.add(rule ?? name);
    if (!rule) unknown.push({ name, index });
  }
  return { rules, unknown };
}

const nameRange = (name: string, start: Position): UnknownRule => ({
  name,
  start,
  end: { line: start.line, column: start.column + name.length },
});

/**
 * The frontmatter source and its first line. A closed block is the parser's `yaml` node. The parser
 * doesn't recognize an unclosed block, which most likely ends at the first blank line.
 */
function frontmatterSource(file: Pick<LintedFile, "ast" | "text">): { source: string; firstLine: number } | null {
  const first = file.ast.children[0];
  if (first?.type === "yaml") {
    return { source: splitLines(first.value).join("\n"), firstLine: (first.position?.start.line ?? 1) + 1 };
  }
  const frontmatter = extractFrontmatter(file.text);
  if (!frontmatter || frontmatter.closed) return null;
  const blank = frontmatter.lines.findIndex((line) => line.trim() === "");
  const lines = blank === -1 ? frontmatter.lines : frontmatter.lines.slice(0, blank);
  return { source: lines.join("\n"), firstLine: frontmatter.firstLine };
}

/** Directives written as `#` comments in the frontmatter. */
function frontmatterDirectives(file: Pick<LintedFile, "ast" | "text">): Directive[] {
  const frontmatter = frontmatterSource(file);
  if (!frontmatter) return [];
  const directives: Directive[] = [];
  const lines = frontmatter.source.split("\n");
  for (const comment of yamlComments(frontmatter.source)) {
    const match = COMMENT_DIRECTIVE_RE.exec(comment.text);
    if (!match) continue;
    const kind = match[1] as DirectiveKind;
    const list = match[2] as string;
    const { rules, unknown } = parseRules(list);
    const line = frontmatter.firstLine + comment.line;
    // A comment runs to the end of its line; the rule list ends it.
    const sourceLine = lines[comment.line] ?? "";
    const listColumn = Math.max(0, sourceLine.lastIndexOf(comment.text)) + comment.text.length - list.length + 1;
    const unknownRules = unknown.map(({ name, index }) => nameRange(name, { line, column: listColumn + index }));
    directives.push({ kind, rules, line, endLine: line, unknownRules });
    // Problems with the frontmatter as a whole are reported on the opening `---`.
    if (kind === "disable") directives.push({ kind: "disable-line", rules, line: 1, endLine: 1, unknownRules: [] });
  }
  return directives;
}

/**
 * Collects `<!-- contextlint-disable[-line|-next-line] [rules] -->` and
 * `<!-- contextlint-enable [rules] -->` comments. A `-- reason` suffix is allowed.
 * Frontmatter has to start on the first line, so it takes the directives as `#` comments
 * instead, and a `disable` there also covers the opening `---`.
 */
export function collectDirectives(file: Pick<LintedFile, "ast" | "text">): Directive[] {
  const directives = frontmatterDirectives(file);
  let sourceLines: string[] | undefined;
  visit(file.ast, "html", (node) => {
    const nodeStart = node.position?.start ?? { line: 1, column: 1 };
    /** Position of an offset in the node's value. */
    const positionAt = (offset: number): Position => {
      const before = node.value.slice(0, offset);
      const line = nodeStart.line + (before.match(/\n/g)?.length ?? 0);
      const newline = before.lastIndexOf("\n");
      if (newline === -1) return { line, column: nodeStart.column + offset };
      // Later lines of the value lack their container prefix (`> `, list indentation), so find
      // where the line's text starts in the source.
      const valueLine = node.value.slice(newline + 1).split(/\r?\n/, 1)[0] ?? "";
      sourceLines ??= splitLines(file.text);
      const indent = Math.max(0, (sourceLines[line - 1] ?? "").indexOf(valueLine));
      return { line, column: indent + offset - newline };
    };
    for (const match of node.value.matchAll(DIRECTIVE_RE)) {
      const line = positionAt(match.index).line;
      const endLine = line + (match[0].match(/\n/g)?.length ?? 0);
      const list = match[2] as string;
      const listOffset = match.index + match[0].length - "-->".length - list.length;
      const { rules, unknown } = parseRules(list);
      const unknownRules = unknown.map(({ name, index }) => nameRange(name, positionAt(listOffset + index)));
      directives.push({ kind: match[1] as DirectiveKind, rules, line, endLine, unknownRules });
    }
  });
  return directives;
}

/**
 * Info diagnostics for names in directives that are not rules. Such a directive suppresses
 * nothing for that name, which is easy to miss when the name has a typo.
 */
export function unknownRuleDiagnostics(filePath: string, directives: readonly Directive[]): Diagnostic[] {
  return directives.flatMap((directive) =>
    directive.unknownRules.map(({ name, start, end }): Diagnostic => {
      const suggestion = suggestRuleName(name);
      return {
        ruleId: null,
        severity: "info",
        message: `Unknown rule \`${name}\` in \`contextlint-${directive.kind}\` directive`,
        help: suggestion
          ? `Did you mean \`${suggestion}\`?`
          : "`contextlint --rules` lists all rules. Separate a reason from the rule names with ` -- `.",
        filePath,
        start,
        end,
      };
    }),
  );
}

function applies(directive: Directive, ruleId: string): boolean {
  return directive.rules === null || directive.rules.has(ruleId);
}

export function applySuppressions(diagnostics: Diagnostic[], directives: Directive[]): Diagnostic[] {
  if (directives.length === 0) return diagnostics;
  // In source order: frontmatter directives come first, then the HTML comments in document order.
  const ranged = directives.filter((d) => d.kind === "disable" || d.kind === "enable");
  return diagnostics.filter((diagnostic) => {
    const ruleId = diagnostic.ruleId;
    if (!ruleId) return true;
    const line = diagnostic.start.line;
    for (const d of directives) {
      if (d.kind === "disable-line" && line >= d.line && line <= d.endLine && applies(d, ruleId)) return false;
      if (d.kind === "disable-next-line" && line === d.endLine + 1 && applies(d, ruleId)) return false;
    }
    let allDisabled = false;
    const perRule = new Map<string, boolean>();
    for (const d of ranged) {
      if (d.line > line) break;
      const disabled = d.kind === "disable";
      if (d.rules === null) {
        allDisabled = disabled;
        perRule.clear();
      } else {
        for (const r of d.rules) perRule.set(r, disabled);
      }
    }
    return !(perRule.get(ruleId) ?? allDisabled);
  });
}
