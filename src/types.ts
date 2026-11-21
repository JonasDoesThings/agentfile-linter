import type { Root } from "mdast";

import type { Project } from "./project.ts";
import type { OptionSchema } from "./schema.ts";

/** Effective severity of a rule. */
export type Severity = "off" | "warn" | "error";

/** Severity as it may be written in a config file or passed on the CLI. */
export type SeverityInput = Severity | "allow" | "deny" | 0 | 1 | 2;

/** Rule categories. A rule may belong to several categories. */
export const CATEGORIES = ["recommended"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface RuleMeta {
  /** Fully qualified rule name, e.g. `context/no-missing-path`. */
  name: string;
  description: string;
  categories: Category[];
  /** Severity used when the rule is enabled through a category. */
  defaultSeverity: Exclude<Severity, "off">;
  /** Schema of the rule's options object (used for validation and JSON schema generation). */
  schema?: OptionSchema;
}

export interface Rule<Options extends object = Record<string, unknown>> {
  meta: RuleMeta;
  defaultOptions: Options;
  check(ctx: RuleContext<Options>): void | Promise<void>;
}

// biome-ignore lint: rule registry holds heterogenous option types
export type AnyRule = Rule<any>;

export interface Position {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface ReportDescriptor {
  message: string;
  help?: string;
  start: Position;
  end?: Position;
}

export interface Diagnostic {
  /** `null` for problems not attributed to a rule (e.g. unreadable files). */
  ruleId: string | null;
  severity: Exclude<Severity, "off">;
  message: string;
  help?: string;
  /** Absolute path of the file associated with this diagnostic. */
  filePath: string;
  start: Position;
  end: Position;
}

export interface LintedFile {
  /** Absolute path (as discovered, not resolved through symlinks). */
  path: string;
  /** Absolute real path (symlinks resolved). */
  realPath: string;
  /** Raw file content. */
  text: string;
  ast: Root;
  /** Offsets of each line start, for offset <-> position conversion. */
  lineStarts: number[];
}

export interface RuleContext<Options> {
  file: LintedFile;
  project: Project;
  options: Options;
  report: (descriptor: ReportDescriptor) => void;
}

export interface FileResult {
  filePath: string;
  diagnostics: Diagnostic[];
}

export interface LintResult {
  /** File results, including discovery errors and warnings for explicitly skipped files. */
  files: FileResult[];
  /** Number of files linted. */
  fileCount: number;
  /** Number of distinct rules that were enabled for at least one file. */
  ruleCount: number;
  errorCount: number;
  warningCount: number;
  durationMs: number;
}
