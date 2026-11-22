import type { Root } from "mdast";
import { CST, Lexer } from "yaml";

import type { RuleRegistry } from "#src/rules/index.ts";

import { extractFrontmatter } from "./frontmatter.ts";
import { visit } from "./markdown.ts";
import { splitLines } from "./text.ts";
import type { Diagnostic, Position } from "./types.ts";

/** A file's text and AST. */
interface ParsedFile {
  text: string;
  ast: Root;
}

type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

export interface Directive {
  kind: DirectiveKind;
  /** Rule names, or null for all rules. */
  rules: Set<string> | null;
  line: number;
  endLine: number;
  /** Location of the whole comment. */
  start: Position;
  end: Position;
  /** The names in the rule list, as written. */
  names: DirectiveName[];
  /** Rules whose problems the directive suppressed, recorded by {@link suppresses}. */
  used: Set<string>;
  /** Added on behalf of another directive, whose `used` it shares. Never reported itself. */
  implicit?: boolean;
}

export interface DirectiveName {
  name: string;
  /** The rule's full name, or undefined for a name that isn't a rule (most likely a typo), which suppresses nothing. */
  rule: string | undefined;
  start: Position;
  end: Position;
}

const DIRECTIVE_RE = /<!--\s*agentfile-linter-(disable-next-line|disable-line|disable|enable)\b([\s\S]*?)-->/g;
/** The same directives as YAML comments in frontmatter: `# agentfile-linter-disable-next-line rule`. */
const COMMENT_DIRECTIVE_RE = /^#\s*agentfile-linter-(disable-next-line|disable-line|disable|enable)\b(.*)$/;

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
  /** The listed names, with their offset in the parsed text. */
  names: { name: string; rule: string | undefined; index: number }[];
}

/** Rule names of a directive (before an optional `-- reason`). */
function parseRules(text: string, registry: RuleRegistry): ParsedRules {
  const list = text.split(/\s--\s|^--\s/)[0] ?? "";
  if (!list.trim()) return { rules: null, names: [] };
  const rules = new Set<string>();
  const names: ParsedRules["names"] = [];
  for (const { 0: name, index } of list.matchAll(/[^\s,]+/g)) {
    const rule = registry.resolve(name);
    rules.add(rule ?? name);
    names.push({ name, rule, index });
  }
  return { rules, names };
}

const nameRange = ({ name, rule }: ParsedRules["names"][number], start: Position): DirectiveName => ({
  name,
  rule,
  start,
  end: { line: start.line, column: start.column + name.length },
});

/**
 * The frontmatter source and its first line. A closed block is the parser's `yaml` node. The parser
 * doesn't recognize an unclosed block, which most likely ends at the first blank line.
 */
function frontmatterSource(file: ParsedFile): { source: string; firstLine: number } | null {
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
function frontmatterDirectives(file: ParsedFile, registry: RuleRegistry): Directive[] {
  const frontmatter = frontmatterSource(file);
  if (!frontmatter) return [];
  const directives: Directive[] = [];
  const lines = frontmatter.source.split("\n");
  for (const comment of yamlComments(frontmatter.source)) {
    const match = COMMENT_DIRECTIVE_RE.exec(comment.text);
    if (!match) continue;
    const kind = match[1] as DirectiveKind;
    const list = match[2] as string;
    const parsed = parseRules(list, registry);
    const line = frontmatter.firstLine + comment.line;
    // A comment runs to the end of its line; the rule list ends it.
    const sourceLine = lines[comment.line] ?? "";
    const column = Math.max(0, sourceLine.lastIndexOf(comment.text)) + 1;
    const listColumn = column + comment.text.length - list.length;
    const directive: Directive = {
      kind,
      rules: parsed.rules,
      line,
      endLine: line,
      start: { line, column },
      end: { line, column: column + comment.text.length },
      names: parsed.names.map((name) => nameRange(name, { line, column: listColumn + name.index })),
      used: new Set(),
    };
    directives.push(directive);
    // Problems with the frontmatter as a whole are reported on the opening `---`.
    if (kind === "disable") {
      directives.push({ ...directive, kind: "disable-line", line: 1, endLine: 1, names: [], implicit: true });
    }
  }
  return directives;
}

/**
 * Collects `<!-- agentfile-linter-disable[-line|-next-line] [rules] -->` and
 * `<!-- agentfile-linter-enable [rules] -->` comments. A `-- reason` suffix is allowed.
 * Frontmatter has to start on the first line, so it takes the directives as `#` comments
 * instead, and a `disable` there also covers the opening `---`.
 */
export function collectDirectives(file: ParsedFile, registry: RuleRegistry): Directive[] {
  const directives = frontmatterDirectives(file, registry);
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
      const start = positionAt(match.index);
      const list = match[2] as string;
      const listOffset = match.index + match[0].length - "-->".length - list.length;
      const parsed = parseRules(list, registry);
      directives.push({
        kind: match[1] as DirectiveKind,
        rules: parsed.rules,
        line: start.line,
        endLine: start.line + (match[0].match(/\n/g)?.length ?? 0),
        start,
        end: positionAt(match.index + match[0].length),
        names: parsed.names.map((name) => nameRange(name, positionAt(listOffset + name.index))),
        used: new Set(),
      });
    }
  });
  return directives;
}

/**
 * Info diagnostics for names in directives that are not rules. Such a directive suppresses
 * nothing for that name, which is easy to miss when the name has a typo.
 */
export function unknownRuleDiagnostics(
  filePath: string,
  directives: readonly Directive[],
  registry: RuleRegistry,
): Diagnostic[] {
  return directives.flatMap((directive) =>
    directive.names.flatMap(({ name, rule, start, end }): Diagnostic[] => {
      if (rule) return [];
      const suggestion = registry.suggest(name);
      return [
        {
          ruleId: null,
          severity: "info",
          message: `Unknown rule \`${name}\` in \`agentfile-linter-${directive.kind}\` directive`,
          help: suggestion
            ? `Did you mean \`${suggestion}\`?`
            : "`agentfile-linter --rules` lists all rules. Separate a reason from the rule names with ` -- `.",
          filePath,
          start,
          end,
        },
      ];
    }),
  );
}

/** Where a directive suppresses problems, for messages. */
const SCOPE: Record<DirectiveKind, string> = {
  disable: "in its range",
  "disable-line": "on this line",
  "disable-next-line": "on the next line",
  enable: "",
};

/**
 * Info diagnostics for directives that suppressed nothing: a directive for all rules that no
 * problem needed, or a listed rule with no problem to suppress. Only rules in `checkedBy`, the
 * rules that checked the file, count: a directive for a rule that is off may be needed where it
 * is on. Call it after all rules have run, so that {@link suppresses} has recorded every use.
 */
export function unnecessarySuppressionDiagnostics(
  filePath: string,
  directives: readonly Directive[],
  checkedBy: ReadonlySet<string>,
  registry: RuleRegistry,
): Diagnostic[] {
  // Problems of a rule that depends on the current time come and go while the file stays the same.
  const isStable = (rule: string) => checkedBy.has(rule) && !registry.get(rule)?.meta?.timeDependent;
  const allStable = checkedBy.size > 0 && [...checkedBy].every(isStable);
  const diagnostics: Diagnostic[] = [];
  for (const directive of directives) {
    if (directive.kind === "enable" || directive.implicit) continue;
    const label = `\`agentfile-linter-${directive.kind}\``;
    const scope = SCOPE[directive.kind];
    if (directive.rules === null) {
      if (directive.used.size > 0 || !allStable) continue;
      diagnostics.push({
        ruleId: null,
        severity: "info",
        message: `Unnecessary ${label} directive`,
        help: `No rule reports a problem ${scope}. Remove the directive.`,
        filePath,
        start: directive.start,
        end: directive.end,
      });
      continue;
    }
    const listed = new Set<string>();
    const unused = directive.names.filter(({ rule }) => {
      if (!rule || listed.has(rule)) return false;
      listed.add(rule);
      return isStable(rule) && !directive.used.has(rule);
    });
    for (const { name, start, end } of unused) {
      const fix = unused.length === listed.size ? "Remove the directive." : `Remove \`${name}\` from the directive.`;
      diagnostics.push({
        ruleId: null,
        severity: "info",
        message: `Unnecessary suppression of \`${name}\` in ${label} directive`,
        help: `The rule reports no problem ${scope}. ${fix}`,
        filePath,
        start,
        end,
      });
    }
  }
  return diagnostics;
}

function applies(directive: Directive, ruleId: string): boolean {
  return directive.rules === null || directive.rules.has(ruleId);
}

/**
 * Whether the directives suppress a problem of `ruleId` on `line`. Each directive that does, every
 * line directive covering it and the range directive in effect, records the rule as used.
 */
export function suppresses(directives: readonly Directive[], ruleId: string, line: number): boolean {
  const found = directives.filter(
    (d) =>
      applies(d, ruleId) &&
      ((d.kind === "disable-line" && line >= d.line && line <= d.endLine) ||
        (d.kind === "disable-next-line" && line === d.endLine + 1)),
  );
  // The `disable` directive in effect for all rules and for single rules (null after an `enable`).
  let all: Directive | null = null;
  const perRule = new Map<string, Directive | null>();
  // In source order: frontmatter directives come first, then the HTML comments in document order.
  for (const d of directives) {
    if (d.kind !== "disable" && d.kind !== "enable") continue;
    if (d.line > line) break;
    const state = d.kind === "disable" ? d : null;
    if (d.rules === null) {
      all = state;
      perRule.clear();
    } else {
      for (const r of d.rules) perRule.set(r, state);
    }
  }
  const range = perRule.has(ruleId) ? perRule.get(ruleId) : all;
  if (range) found.push(range);
  for (const d of found) d.used.add(ruleId);
  return found.length > 0;
}

/** The diagnostics that no directive suppresses. Diagnostics without a rule can't be suppressed. */
export function applySuppressions(diagnostics: Diagnostic[], directives: readonly Directive[]): Diagnostic[] {
  if (directives.length === 0) return diagnostics;
  return diagnostics.filter(({ ruleId, start }) => !ruleId || !suppresses(directives, ruleId, start.line));
}
