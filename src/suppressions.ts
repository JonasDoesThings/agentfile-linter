import { resolveRuleName } from "#src/rules/index.ts";

import { visit } from "./markdown.ts";
import type { Diagnostic, LintedFile } from "./types.ts";

type DirectiveKind = "disable" | "enable" | "disable-line" | "disable-next-line";

interface Directive {
  kind: DirectiveKind;
  /** Rule names, or null for all rules. */
  rules: Set<string> | null;
  line: number;
  endLine: number;
}

const DIRECTIVE_RE = /<!--\s*contextlint-(disable-next-line|disable-line|disable|enable)\b([\s\S]*?)-->/g;

/**
 * Collects `<!-- contextlint-disable[-line|-next-line] [rules] -->` and
 * `<!-- contextlint-enable [rules] -->` comments. A `-- reason` suffix is allowed.
 */
export function collectDirectives(file: LintedFile): Directive[] {
  const directives: Directive[] = [];
  visit(file.ast, "html", (node) => {
    const startLine = node.position?.start.line ?? 1;
    for (const match of node.value.matchAll(DIRECTIVE_RE)) {
      const before = node.value.slice(0, match.index);
      const line = startLine + (before.match(/\n/g)?.length ?? 0);
      const endLine = line + (match[0].match(/\n/g)?.length ?? 0);
      const list = (match[2] as string).split(/\s--\s|^--\s/)[0]?.trim() ?? "";
      const rules = list
        ? new Set(
            list
              .split(/[\s,]+/)
              .filter(Boolean)
              .map((r) => resolveRuleName(r) ?? r),
          )
        : null;
      directives.push({ kind: match[1] as DirectiveKind, rules, line, endLine });
    }
  });
  return directives;
}

function applies(directive: Directive, ruleId: string): boolean {
  return directive.rules === null || directive.rules.has(ruleId);
}

export function applySuppressions(diagnostics: Diagnostic[], directives: Directive[]): Diagnostic[] {
  if (directives.length === 0) return diagnostics;
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
