import type { Nodes } from "mdast";

import type { Project } from "./project.ts";
import type { OptionsSchema } from "./schema.ts";
import type { SourceCode } from "./source-code.ts";

/** Effective severity of a rule. */
export type Severity = "off" | "warn" | "error";

/**
 * Severity of a reported diagnostic. `info` marks notes that are not problems (such as an unknown
 * rule in an inline directive): they are printed but don't count as warnings or errors.
 */
export type DiagnosticSeverity = Exclude<Severity, "off"> | "info";

/** Severity as it may be written in a config file or passed on the CLI. */
export type SeverityInput = Severity | "allow" | "deny" | 0 | 1 | 2;

/** Oxlint's rule categories. Each built-in rule belongs to one, set by `meta.docs.category`. */
export const RULE_CATEGORIES = [
  "correctness",
  "suspicious",
  "pedantic",
  "style",
  "restriction",
  "nursery",
  "perf",
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

/**
 * What `categories` in a config and `-A`/`-W`/`-D` select rules by: a rule category, or
 * `recommended`, the rules that are on by default. Both cover built-in rules only.
 */
export const CATEGORIES = ["recommended", ...RULE_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  recommended: "Rules that are on by default",
  correctness: "Instructions that are wrong, such as references to files or scripts that don't exist",
  suspicious: "Instructions that are most likely wrong",
  pedantic: "Stricter rules, with occasional false positives",
  style: "Setups that could be simpler or more idiomatic",
  restriction: "Rules that forbid things some projects want to avoid",
  nursery: "New rules that are still being developed",
  perf: "Instructions that cost more context than necessary",
};

/** Context file names, spelled exactly as agents look for them. These are the default `files` patterns. */
export const DEFAULT_FILE_PATTERNS = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md"];

/** Rule metadata: ESLint's `meta`, plus `timeDependent`. */
export interface RuleMeta<Options extends unknown[] = unknown[]> {
  type?: "problem" | "suggestion" | "layout";
  docs?: {
    description?: string;
    /** Turns a built-in rule on by default, as an error (the `recommended` category). */
    recommended?: boolean;
    /**
     * agentfile-linter extension: the category of a built-in rule. ESLint and Oxlint allow custom
     * properties in `docs`, and like Oxlint, agentfile-linter ignores the categories of plugin rules.
     */
    category?: RuleCategory;
    url?: string;
    /** Other properties, as in ESLint and Oxlint. */
    [key: string]: unknown;
  };
  /** Messages by id, for `report({ messageId })`. `{{ key }}` placeholders take their values from `data`. */
  messages?: Record<string, string>;
  /** JSON schema of the options. Without one the rule takes no options. */
  schema?: OptionsSchema;
  /** Options the configured options are merged over (objects key by key). */
  defaultOptions?: Options;
  /** Accepted for compatibility: agentfile-linter doesn't apply fixes or suggestions. */
  fixable?: "code" | "whitespace";
  hasSuggestions?: boolean;
  deprecated?: boolean;
  /**
   * agentfile-linter extension: the rule's problems depend on the current time, so they can appear
   * while the files stay the same. A directive for such a rule is never reported as unnecessary.
   */
  timeDependent?: boolean;
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

export type NodeOfType<T extends Nodes["type"]> = Extract<Nodes, { type: T }>;
type Listener<N> = (node: N) => void | Promise<void>;
type NodeOf<S> = S extends `${infer T extends Nodes["type"]}:exit`
  ? NodeOfType<T>
  : S extends Nodes["type"]
    ? NodeOfType<S>
    : never;

/**
 * Functions called while walking the Markdown AST (mdast): `link(node)` on entering a link node,
 * `"link:exit"(node)` on leaving it. A key can also be `*` or a list of node types (`"heading,
 * paragraph"` or `":matches(heading, paragraph)"`). A returned promise is awaited before the
 * results are reported (an agentfile-linter extension).
 */
export type Visitor = { [S in Nodes["type"] | `${Nodes["type"]}:exit`]?: Listener<NodeOf<S>> } & {
  // Other selectors can match nodes of any type.
  [selector: string]: Listener<any> | undefined;
};

/** What Oxlint's `createOnce` returns: a visitor with hooks that run before and after each file. */
export type VisitorWithHooks = Visitor & {
  /** Runs before a file's AST is walked. Returning `false` skips the file. */
  before?: () => boolean | void;
  /** Runs after a file's AST is walked. A returned promise is awaited, as for visitor functions. */
  after?: () => void | Promise<void>;
};

/**
 * A rule, in the shape of ESLint and Oxlint rules: `meta` and `create` (or Oxlint's `createOnce`),
 * which checks one context file. Rules about other things than context files (such as skill
 * directories) implement the agentfile-linter hooks `collectTreeInputs` and `checkTree` instead.
 */
export interface Rule<Options extends unknown[] = unknown[], Input extends TreeInput = TreeInput> {
  meta?: RuleMeta<Options>;
  /** Called once per context file. Returns the functions that check the file's nodes. */
  create?: (context: RuleContext<Options>) => Visitor;
  /** Oxlint's alternative to `create`. agentfile-linter calls it once per file too. */
  createOnce?: (context: RuleContext<Options>) => VisitorWithHooks;
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

// The registry holds rules with different options.
export type AnyRule = Rule<any, any>;

/** A plugin, in the shape of ESLint and Oxlint plugins. */
export interface Plugin {
  meta?: { name?: string; version?: string };
  rules?: Record<string, AnyRule>;
}

export interface Position {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface SourceLocation {
  start: Position;
  end: Position;
}

/** What `report` takes, as in ESLint: a message (or message id) and a node or location. */
export interface ReportDescriptor {
  message?: string;
  /** A key of `meta.messages`, used instead of `message`. */
  messageId?: string;
  /** Values for the `{{ key }}` placeholders in the message. */
  data?: Record<string, unknown>;
  /** The node the problem is reported at. */
  node?: Nodes;
  /** Where the problem is reported, instead of `node`: a range or a single position. */
  loc?: { start: Position; end?: Position } | Position;
  /** agentfile-linter extension: how to fix the problem. ESLint and Oxlint ignore it. */
  help?: string;
  /** Accepted for compatibility: agentfile-linter doesn't apply fixes or suggestions. */
  fix?: unknown;
  suggest?: unknown;
}

export interface Diagnostic {
  /** `null` for problems not attributed to a rule (e.g. unreadable files). */
  ruleId: string | null;
  severity: DiagnosticSeverity;
  message: string;
  help?: string;
  /** Absolute path of the file associated with this diagnostic. */
  filePath: string;
  start: Position;
  end: Position;
}

/** What a rule's `create` gets, as in ESLint and Oxlint. */
export interface RuleContext<Options extends unknown[] = unknown[]> {
  /** The rule's name, e.g. `agentfile/no-missing-path`. */
  readonly id: string;
  /** The options from the config, merged over `meta.defaultOptions`. */
  readonly options: Options;
  /** `settings` from the config. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Absolute path of the file (as discovered, not resolved through symlinks). */
  readonly filename: string;
  readonly physicalFilename: string;
  /** Working directory of the lint invocation. */
  readonly cwd: string;
  readonly sourceCode: SourceCode;
  readonly report: (descriptor: ReportDescriptor) => void;
  /** agentfile-linter extension: cached file system access to the file's project (its nearest Git root). */
  readonly project: Project;
}

export interface TreeDiscoveryContext<Options extends unknown[]> {
  /** Discovered directories, including symlink entries, sorted. */
  directories: readonly string[];
  /** Directories and files selected at the lint entry point. */
  directoryInputs: readonly string[];
  explicitFiles: readonly string[];
  /** The project (nearest Git root) a path belongs to. */
  projectFor(dir: string): Project;
  /** Whether a path is excluded from linting (.gitignore, ignore patterns), as during discovery. */
  isIgnored(path: string, isDir: boolean): boolean;
  /** Whether a path matches the configured context file patterns (`files`). */
  isContextFile(path: string): boolean;
  /**
   * The rule's options for `path`: config plus the overrides matching `path` or, when given, `root`.
   * Options never depend on the rule's severity; see `TreeContext.isEnabled`.
   */
  optionsFor(path: string, root?: string): Options;
  /** The base options and those of every override, to find all inputs any of them can select. */
  discoveryOptions: readonly Options[];
}

export interface TreeContext<
  Options extends unknown[],
  Input extends TreeInput = TreeInput,
> extends TreeDiscoveryContext<Options> {
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
  /**
   * Reports a problem in `filePath` (a file or directory) at the severity configured for that path.
   * Without `node` or `loc`, the problem is reported at line 1, column 1.
   */
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
