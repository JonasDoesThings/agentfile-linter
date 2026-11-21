import { basename, dirname, join } from "node:path";

import type { Project } from "#src/project.ts";
import type { Rule } from "#src/types.ts";

export interface NoAgentFilesDriftOptions {
  /** File names (in one directory) that must stay in sync, in order of precedence. */
  files: string[];
  /** Treat a file consisting only of `@OTHER.md` imports as in sync with the imported file. */
  allowImports: boolean;
}

export function normalizeContent(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** If `text` consists solely of `@path` imports, returns the imported paths. */
export function pointerImports(text: string): string[] | null {
  const stripped = text.replace(/^﻿/, "").replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const imports: string[] = [];
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    if (!tokens.every((t) => /^@[^\s@]+$/.test(t))) return null;
    imports.push(...tokens.map((t) => t.slice(1).replace(/^\.\//, "")));
  }
  return imports;
}

function firstDifferentLine(a: string, b: string): number {
  const la = a.split("\n");
  const lb = b.split("\n");
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) return Math.min(i + 1, la.length);
  }
  return 1;
}

interface Effective {
  /** Normalized content the agent effectively sees. */
  content: string;
  /** File the content comes from (differs from the file itself for pointers). */
  source: string;
}

type EffectiveResult = Effective | { cycle: true } | { unresolved: true };

function resolveEffective(
  project: Project,
  absPath: string,
  allowImports: boolean,
  overrides: Map<string, string>,
  seen: Set<string> = new Set(),
): EffectiveResult {
  if (seen.has(absPath)) return { cycle: true };
  seen.add(absPath);
  const raw = overrides.get(absPath) ?? project.readText(absPath);
  if (raw === null) return { unresolved: true };
  const imports = allowImports ? pointerImports(raw) : null;
  if (!imports) return { content: normalizeContent(raw), source: absPath };
  const dir = dirname(absPath);
  for (const imp of imports) {
    const target = join(dir, imp);
    if (!project.isFile(target)) continue;
    return resolveEffective(project, target, allowImports, overrides, seen);
  }
  return { unresolved: true };
}

export const noAgentFilesDrift: Rule<NoAgentFilesDriftOptions> = {
  meta: {
    name: "agentfile/no-agent-files-drift",
    description: "AGENTS.md, CLAUDE.md, GEMINI.md, ... in the same directory must be identical or symlinked",
    categories: ["recommended"],
    defaultSeverity: "error",
    schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "File names that must stay in sync, in order of precedence (the first existing one is canonical).",
        },
        allowImports: {
          type: "boolean",
          description: "Treat a file that only contains `@AGENTS.md`-style imports of a sibling as in sync.",
        },
      },
    },
  },
  defaultOptions: { files: ["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md"], allowImports: true },
  check({ file, project, options, report }) {
    const name = basename(file.path);
    if (!options.files.includes(name)) return;
    const dir = dirname(file.path);
    const members = options.files.filter((f) => f === name || project.isFile(join(dir, f)));
    if (members.length < 2) return;

    const overrides = new Map([[file.path, file.text]]);
    const effective = (member: string) => resolveEffective(project, join(dir, member), options.allowImports, overrides);

    const self = effective(name);
    if ("cycle" in self) {
      report({
        message: `\`${name}\` is part of an import cycle; no file contains the actual instructions`,
        start: { line: 1, column: 1 },
      });
      return;
    }
    if ("unresolved" in self) return; // broken import: reported by agentfile/no-missing-path

    let canonical: { name: string; value: Effective } | undefined;
    for (const member of members) {
      const value = member === name ? self : effective(member);
      if ("content" in value) {
        canonical = { name: member, value };
        break;
      }
    }
    if (!canonical || canonical.name === name) return;
    if (self.content === canonical.value.content) return;

    const isPointer = self.source !== file.path;
    const line = isPointer ? 1 : firstDifferentLine(normalizeContent(file.text), canonical.value.content);
    const lineText = file.text.split(/\r?\n/)[line - 1] ?? "";
    const fixes = [`symlink it (\`ln -sf ${canonical.name} ${name}\`)`, "copy the content over"];
    if (options.allowImports) fixes.push(`replace its content with \`@${canonical.name}\``);
    report({
      message: isPointer
        ? `\`${name}\` imports \`${basename(self.source)}\`, whose content differs from \`${canonical.name}\``
        : `\`${name}\` has drifted from \`${canonical.name}\` (first difference at line ${line})`,
      help: `Keep agent files in sync: ${fixes.slice(0, -1).join(", ")} or ${fixes.at(-1)}.`,
      start: { line, column: 1 },
      end: { line, column: Math.max(1, lineText.length + 1) },
    });
  },
};
