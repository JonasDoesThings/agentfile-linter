import { CST, Lexer } from "yaml";

import { resolveRuleName } from "#src/rules/index.ts";

import { extractFrontmatter } from "./frontmatter.ts";
import { visit } from "./markdown.ts";
import { splitLines } from "./text.ts";
import type { Diagnostic, LintedFile } from "./types.ts";

type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

export interface Directive {
  kind: DirectiveKind;
  /** Rule names, or null for all rules. */
  rules: Set<string> | null;
  line: number;
  endLine: number;
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

/** Rule names of a directive (before an optional `-- reason`), or null for all rules. */
function parseRules(text: string): Set<string> | null {
  const list = text.split(/\s--\s|^--\s/)[0]?.trim() ?? "";
  if (!list) return null;
  return new Set(
    list
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((r) => resolveRuleName(r) ?? r),
  );
}

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
  for (const comment of yamlComments(frontmatter.source)) {
    const match = COMMENT_DIRECTIVE_RE.exec(comment.text);
    if (!match) continue;
    const kind = match[1] as DirectiveKind;
    const rules = parseRules(match[2] as string);
    const line = frontmatter.firstLine + comment.line;
    directives.push({ kind, rules, line, endLine: line });
    // Problems with the frontmatter as a whole are reported on the opening `---`.
    if (kind === "disable") directives.push({ kind: "disable-line", rules, line: 1, endLine: 1 });
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
  visit(file.ast, "html", (node) => {
    const startLine = node.position?.start.line ?? 1;
    for (const match of node.value.matchAll(DIRECTIVE_RE)) {
      const before = node.value.slice(0, match.index);
      const line = startLine + (before.match(/\n/g)?.length ?? 0);
      const endLine = line + (match[0].match(/\n/g)?.length ?? 0);
      directives.push({ kind: match[1] as DirectiveKind, rules: parseRules(match[2] as string), line, endLine });
    }
  });
  return directives;
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
