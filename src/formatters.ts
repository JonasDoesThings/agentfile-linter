import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { type Colors, getColors } from "./colors.ts";
import type { Diagnostic, DiagnosticSeverity, LintResult } from "./types.ts";
import { assertNever } from "./util.ts";

export const FORMATS = ["default", "stylish", "json", "github", "unix"] as const;
export type Format = (typeof FORMATS)[number];

export interface FormatOptions {
  cwd: string;
  color: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const SEVERITY_LABELS: Record<DiagnosticSeverity, string> = { error: "error", warn: "warning", info: "info" };

function paint(c: Colors, severity: DiagnosticSeverity, s: string): string {
  return severity === "error" ? c.red(s) : severity === "warn" ? c.yellow(s) : c.cyan(s);
}

/**
 * Whether a diagnostic points at the file's content. Problems with the file as a whole (unreadable,
 * skipped) have no rule and an empty range at its start.
 */
function pointsIntoFile(d: Diagnostic): boolean {
  return d.ruleId !== null || d.start.line !== d.end.line || d.start.column !== d.end.column;
}

/** `agentfile/no-missing-path` -> `agentfile(no-missing-path)` (oxlint style). */
function ruleCode(ruleId: string | null): string {
  if (!ruleId) return "agentfile-linter";
  const slash = ruleId.indexOf("/");
  return slash === -1 ? ruleId : `${ruleId.slice(0, slash)}(${ruleId.slice(slash + 1)})`;
}

function displayPath(cwd: string, filePath: string): string {
  return relative(cwd, filePath) || filePath;
}

/** Renders inline-code backticks as emphasis in color terminals; keeps them otherwise. */
function prettyMessage(message: string, c: Colors, color: boolean): string {
  return color ? message.replace(/`([^`]+)`/g, (_, code: string) => c.bold(code)) : message;
}

function codeFrame(source: string[], d: Diagnostic, c: Colors, location: string): string[] {
  const line = d.start.line;
  const first = Math.max(1, line - 1);
  const last = Math.min(source.length, line + 1);
  const width = String(last).length;
  const gutter = " ".repeat(width);
  const out = [`${gutter} ${c.dim("╭─[")}${c.cyan(location)}${c.dim("]")}`];
  for (let n = first; n <= last; n++) {
    const text = (source[n - 1] ?? "").replace(/\t/g, " ");
    out.push(`${c.dim(`${String(n).padStart(width)} │`)} ${text}`);
    if (n === line) {
      const startCol = Math.max(1, d.start.column);
      const endCol = d.end.line === line && d.end.column > startCol ? d.end.column : text.length + 1;
      const length = Math.max(1, endCol - startCol);
      const marker = "─".repeat(length);
      out.push(`${c.dim(`${gutter} ·`)} ${" ".repeat(startCol - 1)}${paint(c, d.severity, marker)}`);
    }
  }
  out.push(`${gutter} ${c.dim("╰────")}`);
  return out;
}

function formatDefault(result: LintResult, opts: FormatOptions): string {
  const c = getColors(opts.color);
  const blocks: string[] = [];
  for (const file of result.files) {
    if (!file.diagnostics.length) continue;
    let source: string[] = [];
    if (file.diagnostics.some(pointsIntoFile)) {
      try {
        source = readFileSync(file.filePath, "utf8").split(/\r?\n/);
      } catch {
        // unreadable or a directory: no code frame
      }
    }
    const path = displayPath(opts.cwd, file.filePath);
    for (const d of file.diagnostics) {
      const icon = paint(c, d.severity, d.severity === "error" ? "×" : d.severity === "warn" ? "⚠" : "ℹ");
      const code = paint(c, d.severity, ruleCode(d.ruleId));
      const lines = [`  ${icon} ${code}: ${prettyMessage(d.message, c, opts.color)}`];
      const location = `${path}:${d.start.line}:${d.start.column}`;
      if (source.length) lines.push(...codeFrame(source, d, c, location).map((l) => `  ${l}`));
      else lines.push(`    ${c.dim("at")} ${c.cyan(location)}`);
      if (d.help) lines.push(`  ${c.cyan("help")}: ${prettyMessage(d.help, c, opts.color)}`);
      blocks.push(lines.join("\n"));
    }
  }
  const summary = [
    `Found ${plural(result.warningCount, "warning")} and ${plural(result.errorCount, "error")}.`,
    `Finished in ${Math.round(result.durationMs)}ms on ${plural(result.fileCount, "file")} with ${plural(result.ruleCount, "rule")}.`,
  ].join("\n");
  return blocks.length ? `${blocks.join("\n\n")}\n\n${summary}\n` : `${summary}\n`;
}

function formatStylish(result: LintResult, opts: FormatOptions): string {
  const c = getColors(opts.color);
  const out: string[] = [];
  for (const file of result.files) {
    if (!file.diagnostics.length) continue;
    out.push(c.underline(displayPath(opts.cwd, file.filePath)));
    const rows = file.diagnostics.map((d) => [
      `${d.start.line}:${d.start.column}`,
      SEVERITY_LABELS[d.severity],
      d.message,
      d.ruleId ?? "",
      d.severity,
    ]);
    const posWidth = Math.max(...rows.map((r) => (r[0] as string).length));
    const sevWidth = Math.max(...rows.map((r) => (r[1] as string).length));
    const msgWidth = Math.max(...rows.map((r) => (r[2] as string).length));
    for (const [pos, label, msg, rule, severity] of rows as [string, string, string, string, DiagnosticSeverity][]) {
      const sevText = paint(c, severity, label.padEnd(sevWidth));
      out.push(`  ${c.dim(pos.padEnd(posWidth))}  ${sevText}  ${msg.padEnd(msgWidth)}  ${c.dim(rule)}`.trimEnd());
    }
    out.push("");
  }
  const total = result.errorCount + result.warningCount;
  if (total > 0) {
    const line = `✖ ${plural(total, "problem")} (${plural(result.errorCount, "error")}, ${plural(result.warningCount, "warning")})`;
    out.push(result.errorCount ? c.red(c.bold(line)) : c.yellow(c.bold(line)));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

function formatJson(result: LintResult, opts: FormatOptions): string {
  const diagnostics = result.files.flatMap((file) =>
    file.diagnostics.map((d) => ({
      message: d.message,
      code: ruleCode(d.ruleId),
      rule: d.ruleId,
      severity: SEVERITY_LABELS[d.severity],
      help: d.help ?? null,
      filename: displayPath(opts.cwd, file.filePath),
      start: d.start,
      end: d.end,
    })),
  );
  return `${JSON.stringify(
    {
      diagnostics,
      number_of_files: result.fileCount,
      number_of_rules: result.ruleCount,
      errors: result.errorCount,
      warnings: result.warningCount,
    },
    null,
    2,
  )}\n`;
}

const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function formatGithub(result: LintResult, opts: FormatOptions): string {
  const out: string[] = [];
  for (const file of result.files) {
    for (const d of file.diagnostics) {
      const props = [
        `file=${escapeProperty(displayPath(opts.cwd, file.filePath))}`,
        `line=${d.start.line}`,
        `endLine=${d.end.line}`,
        `col=${d.start.column}`,
        `endColumn=${d.end.column}`,
        `title=${escapeProperty(d.ruleId ?? "agentfile-linter")}`,
      ];
      const message = d.help ? `${d.message}\n${d.help}` : d.message;
      const command = d.severity === "info" ? "notice" : SEVERITY_LABELS[d.severity];
      out.push(`::${command} ${props.join(",")}::${escapeData(message)}`);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

function formatUnix(result: LintResult, opts: FormatOptions): string {
  const out: string[] = [];
  for (const file of result.files) {
    for (const d of file.diagnostics) {
      const label = SEVERITY_LABELS[d.severity];
      const sev = `${label[0]?.toUpperCase()}${label.slice(1)}`;
      out.push(
        `${displayPath(opts.cwd, file.filePath)}:${d.start.line}:${d.start.column}: ${d.message} [${sev}/${d.ruleId ?? "agentfile-linter"}]`,
      );
    }
  }
  if (!out.length) return "";
  const total = result.errorCount + result.warningCount;
  return total ? `${out.join("\n")}\n\n${plural(total, "problem")}\n` : `${out.join("\n")}\n`;
}

export function format(result: LintResult, fmt: Format, opts: FormatOptions): string {
  switch (fmt) {
    case "default":
      return formatDefault(result, opts);
    case "stylish":
      return formatStylish(result, opts);
    case "json":
      return formatJson(result, opts);
    case "github":
      return formatGithub(result, opts);
    case "unix":
      return formatUnix(result, opts);
    default:
      return assertNever(fmt);
  }
}
