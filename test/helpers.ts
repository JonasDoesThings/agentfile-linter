import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliRuleFlag } from "#src/config.ts";
import { type LintOptions, lint } from "#src/linter.ts";
import type { Diagnostic } from "#src/types.ts";

export type FileSpec = string | { symlink: string } | Record<string, unknown>;

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * Creates a temporary project. String values are written verbatim, objects as
 * JSON, `{ symlink: target }` creates a symlink. A `.git` dir marks the root.
 */
export function makeProject(files: Record<string, FileSpec>, { git = true } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "contextlint-test-")));
  created.push(root);
  if (git) mkdirSync(join(root, ".git"));
  for (const [path, spec] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    if (path.endsWith("/")) {
      mkdirSync(abs, { recursive: true });
    } else if (typeof spec === "string") {
      writeFileSync(abs, spec);
    } else if ("symlink" in spec && typeof spec.symlink === "string") {
      symlinkSync(spec.symlink, abs);
    } else {
      writeFileSync(abs, JSON.stringify(spec, null, 2));
    }
  }
  return root;
}

export interface SimpleDiagnostic {
  file: string;
  rule: string | null;
  line: number;
  column: number;
  message: string;
  help: string | undefined;
  severity: string;
}

export async function run(root: string, options: Omit<LintOptions, "cwd"> = {}): Promise<SimpleDiagnostic[]> {
  const result = await lint({ cwd: root, ...options });
  return result.files.flatMap((f) =>
    f.diagnostics.map((d: Diagnostic) => ({
      file: f.filePath.slice(root.length + 1),
      rule: d.ruleId,
      line: d.start.line,
      column: d.start.column,
      message: d.message,
      help: d.help,
      severity: d.severity,
    })),
  );
}

/** Runs a single rule (all others disabled). */
export function runRule(root: string, rule: string, options: Omit<LintOptions, "cwd" | "ruleFlags"> = {}) {
  const ruleFlags: CliRuleFlag[] = [
    { severity: "off", target: "all" },
    { severity: "error", target: rule },
  ];
  return run(root, { config: false, ...options, ruleFlags });
}

export const messages = (diagnostics: SimpleDiagnostic[]) => diagnostics.map((d) => d.message);
