import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { type Colors, getColors } from "./colors.ts";
import type { Diagnostic, LintResult } from "./types.ts";
import { assertNever } from "./util.ts";

export const FORMATS = ["default", "stylish", "json", "github", "unix"] as const;
export type Format = (typeof FORMATS)[number];

export interface FormatOptions {
  cwd: string;
  color: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `context/no-missing-path` -> `context(no-missing-path)` (oxlint style). */
function ruleCode(ruleId: string | null): string {
  if (!ruleId) return "contextlint";
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
      const colored = d.severity === "error" ? c.red(marker) : c.yellow(marker);
      out.push(`${c.dim(`${gutter} ·`)} ${" ".repeat(startCol - 1)}${colored}`);
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
    if (file.diagnostics.some((d) => d.ruleId !== null)) {
      try {
        source = readFileSync(file.filePath, "utf8").split(/\r?\n/);
      } catch {
        // unreadable: no code frame
      }
    }
    const path = displayPath(opts.cwd, file.filePath);
    for (const d of file.diagnostics) {
      const icon = d.severity === "error" ? c.red("×") : c.yellow("⚠");
      const code = d.severity === "error" ? c.red(ruleCode(d.ruleId)) : c.yellow(ruleCode(d.ruleId));
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
      d.severity === "error" ? "error" : "warning",
      d.message,
      d.ruleId ?? "",
    ]);
    const posWidth = Math.max(...rows.map((r) => (r[0] as string).length));
    const sevWidth = Math.max(...rows.map((r) => (r[1] as string).length));
    const msgWidth = Math.max(...rows.map((r) => (r[2] as string).length));
    for (const [pos, sev, msg, rule] of rows as [string, string, string, string][]) {
      const sevText = sev === "error" ? c.red(sev.padEnd(sevWidth)) : c.yellow(sev.padEnd(sevWidth));
      out.push(`  ${c.dim(pos.padEnd(posWidth))}  ${sevText}  ${msg.padEnd(msgWidth)}  ${c.dim(rule)}`.trimEnd());
    }
    out.push("");
  }
  const total = result.errorCount + result.warningCount;
  if (total > 0) {
    const line = `✖ ${plural(total, "problem")} (${plural(result.errorCount, "error")}, ${plural(result.warningCount, "warning")})`;
    out.push(result.errorCount ? c.red(c.bold(line)) : c.yellow(c.bold(line)));
    return `${out.join("\n")}\n`;
  }
  return "";
}

function formatJson(result: LintResult, opts: FormatOptions): string {
  const diagnostics = result.files.flatMap((file) =>
    file.diagnostics.map((d) => ({
      message: d.message,
      code: ruleCode(d.ruleId),
      rule: d.ruleId,
      severity: d.severity === "error" ? "error" : "warning",
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
        `title=${escapeProperty(d.ruleId ?? "contextlint")}`,
      ];
      const message = d.help ? `${d.message}\n${d.help}` : d.message;
      out.push(`::${d.severity === "error" ? "error" : "warning"} ${props.join(",")}::${escapeData(message)}`);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

function formatUnix(result: LintResult, opts: FormatOptions): string {
  const out: string[] = [];
  for (const file of result.files) {
    for (const d of file.diagnostics) {
      const sev = d.severity === "error" ? "Error" : "Warning";
      out.push(
        `${displayPath(opts.cwd, file.filePath)}:${d.start.line}:${d.start.column}: ${d.message} [${sev}/${d.ruleId ?? "contextlint"}]`,
      );
    }
  }
  const total = result.errorCount + result.warningCount;
  return total ? `${out.join("\n")}\n\n${plural(total, "problem")}\n` : "";
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
