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

/** A file or directory found by a tree rule's discovery, such as a SKILL.md file. */
export interface TreeInput {
  /** Absolute path. */
  path: string;
  /**
   * A directory the input was found in (such as a skills root). Overrides matching it apply to the
   * input like overrides matching `path`, for severity and options alike.
   */
  root?: string;
}

export interface Rule<Options extends object = Record<string, unknown>, Input extends TreeInput = TreeInput> {
  meta: RuleMeta;
  defaultOptions: Options;
  /** Checks one context file. */
  check?(ctx: RuleContext<Options>): void | Promise<void>;
  /**
   * Finds additional inputs without running their checks, once per run, regardless of the rule's
   * severity. The linter keeps the inputs at paths where the rule is on: their paths join the file
   * list, and they are passed to `checkTree` as `ctx.treeInputs`.
   */
  collectTreeInputs?(ctx: TreeDiscoveryContext<Options>): Input[];
  /**
   * Checks the linted directory tree as a whole, once per run. Used for things
   * that are not context files themselves, such as skill directories.
   */
  checkTree?(ctx: TreeContext<Options, Input>): void | Promise<void>;
}

// biome-ignore lint: rule registry holds heterogenous option types
export type AnyRule = Rule<any, any>;

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

export interface TreeDiscoveryContext<Options> {
  /** Discovered directories, including symlink entries, sorted. */
  directories: readonly string[];
  /** Directories and files selected at the lint entry point. */
  directoryInputs: readonly string[];
  explicitFiles: readonly string[];
  /** The project (nearest Git root) a path belongs to. */
  projectFor(dir: string): Project;
  /** Whether a path is excluded from linting (.gitignore, ignore patterns), as during discovery. */
  isIgnored(path: string, isDir: boolean): boolean;
  /**
   * The rule's options for `path`: config plus the overrides matching `path` or, when given, `root`.
   * Options never depend on the rule's severity; see `TreeContext.isEnabled`.
   */
  optionsFor(path: string, root?: string): Options;
  /** The base options and every override's options, to find all inputs any of them can select. */
  discoveryOptions: readonly Partial<Options>[];
}

export interface TreeContext<Options, Input extends TreeInput = TreeInput> extends TreeDiscoveryContext<Options> {
  /** Working directory of the lint invocation. */
  cwd: string;
  /** What the rule's `collectTreeInputs` found where the rule is on (empty without that hook). */
  treeInputs: readonly Input[];
  /** Selected context paths, including symlinks whose content is checked through another path. */
  contextFiles: readonly string[];
  /** Whether the rule is on for `path` (`report` ignores other paths). */
  isEnabled(path: string): boolean;
  /** Whether an inline directive suppresses this rule at the given location. */
  isSuppressed(path: string, start: Position): boolean;
  /** Records an enabled check of a file, including one with no diagnostics. */
  markChecked(path: string): void;
  /** Reports a problem in `filePath` (a file or directory) at the severity configured for that path. */
  report(filePath: string, descriptor: ReportDescriptor): void;
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
