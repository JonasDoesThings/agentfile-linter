import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { BUILTIN_RULES, type RuleRegistry } from "#src/rules/index.ts";

import {
  type CliRuleFlag,
  type Config,
  ConfigError,
  type EnabledRule,
  emptyConfig,
  findConfigFile,
  loadConfigFile,
  loadRuleRegistry,
  matchesFilePattern,
  RuleResolver,
} from "./config.ts";
import { discoverFiles } from "./discovery.ts";
import { PatternIgnore } from "./gitignore.ts";
import { parseMarkdown } from "./markdown.ts";
import { ALWAYS_SKIPPED_DIRS, type Project, ProjectRegistry, tryRealpath } from "./project.ts";
import { crashDiagnostic, runRules, toDiagnostic } from "./rule-runner.ts";
import type { RuleTimings } from "./rule-timings.ts";
import { SourceCode } from "./source-code.ts";
import {
  applySuppressions,
  collectDirectives,
  type Directive,
  suppresses,
  unknownRuleDiagnostics,
  unnecessarySuppressionDiagnostics,
} from "./suppressions.ts";
import type {
  Diagnostic,
  FileResult,
  LintResult,
  Position,
  TreeContext,
  TreeDiscoveryContext,
  TreeInput,
} from "./types.ts";

export const DEFAULT_IGNORE_FILE = ".agentfile-linterignore";

export interface LintOptions {
  /** Working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Files or directories to lint, relative to cwd (defaults to `.`). */
  paths?: string[];
  /** Config file path; `false` disables config loading; undefined auto-discovers. */
  config?: string | false;
  /** `-A` / `-W` / `-D` flags in command-line order. */
  ruleFlags?: CliRuleFlag[];
  /** Additional gitignore-style patterns (relative to cwd). */
  ignorePatterns?: string[];
  /** Ignore file (defaults to `.agentfile-linterignore` in cwd, if present). */
  ignorePath?: string;
  /** Disable .gitignore, ignore files and ignore patterns. */
  noIgnore?: boolean;
  /** Collect per-rule callback timings for this run. */
  ruleTimings?: RuleTimings;
}

export interface LintSetup {
  cwd: string;
  config: Config;
  resolver: RuleResolver;
}

/** Loads the configuration and its plugins, and validates CLI rule flags. Throws {@link ConfigError}. */
export async function setup(options: LintOptions = {}): Promise<LintSetup> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = configPath(options, cwd);
  const config = path ? await loadConfigFile(path) : emptyConfig(cwd);
  return { cwd, config, resolver: new RuleResolver(config, options.ruleFlags) };
}

/** The config file of a run, or null for none. Throws {@link ConfigError} when `options.config` doesn't exist. */
function configPath(options: LintOptions, cwd: string): string | null {
  if (options.config === false) return null;
  if (!options.config) return findConfigFile(cwd);
  const path = resolve(cwd, options.config);
  if (!existsSync(path)) throw new ConfigError(`Config file not found: ${options.config}`);
  return path;
}

/**
 * The rules of a run, for `--rules`: the built-in rules and those of the config's plugins that
 * load. Problems with the config, such as plugins that fail to load, are returned instead of thrown.
 */
export async function availableRules(
  options: LintOptions = {},
): Promise<{ registry: RuleRegistry; problems: string[] }> {
  let path: string | null;
  try {
    path = configPath(options, resolve(options.cwd ?? process.cwd()));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { registry: BUILTIN_RULES, problems: [error.message] };
  }
  return loadRuleRegistry(path);
}

function readIgnoreFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function fileDiagnostic(filePath: string, message: string, severity: Diagnostic["severity"] = "error"): Diagnostic {
  const pos: Position = { line: 1, column: 1 };
  return { ruleId: null, severity, message, filePath, start: pos, end: pos };
}

/** Inline directives by real path, shared by the per-file and tree passes so that each file is parsed once. */
type DirectiveCache = Map<string, Directive[]>;

/** Directives of a file the per-file pass didn't parse. Only files that mention `agentfile-linter-` are parsed. */
function treeFileDirectives(
  path: string,
  realPath: string,
  projects: ProjectRegistry,
  rules: RuleRegistry,
  cache: DirectiveCache,
) {
  let directives = cache.get(realPath);
  if (!directives) {
    const project = projects.forDirectory(dirname(path));
    const text = project.isFile(path) ? project.readText(path) : null;
    directives =
      text === null || !text.includes("agentfile-linter-")
        ? []
        : collectDirectives({ text, ast: parseMarkdown(text) }, rules);
    cache.set(realPath, directives);
  }
  return directives;
}

/** Runs the per-file rules (`create` and `createOnce`) over one file. */
async function lintFile(
  path: string,
  project: Project,
  rules: EnabledRule[],
  { cwd, config }: LintSetup,
  directiveCache: DirectiveCache,
  timings?: RuleTimings,
): Promise<Diagnostic[]> {
  let text: string;
  let realPath: string;
  try {
    realPath = realpathSync(path);
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = project.isSymlink(path) ? "broken symbolic link" : (error as NodeJS.ErrnoException).code;
    return [fileDiagnostic(path, `Cannot read file (${reason ?? "unknown error"})`)];
  }
  const sourceCode = new SourceCode(text, parseMarkdown(text));
  const directives = collectDirectives(sourceCode, config.registry);
  directiveCache.set(realPath, directives);
  const { settings } = config;
  const diagnostics = await runRules(rules, { filename: path, cwd, sourceCode, project, settings }, timings);
  const kept = [
    ...applySuppressions(diagnostics, directives),
    ...unknownRuleDiagnostics(path, directives, config.registry),
  ];
  return kept.toSorted((a, b) => a.start.line - b.start.line || a.start.column - b.start.column);
}

/**
 * Returns the sorted absolute paths of files `lint` would check, including additional rule inputs.
 */
export async function collectFiles(options: LintOptions, prepared?: LintSetup): Promise<string[]> {
  prepared ??= await setup(options);
  const inputs = collectInputs(options, prepared, new ProjectRegistry(prepared.cwd));
  const { files, unreadableDirectories } = inputs;
  if (unreadableDirectories.size) {
    const details = [...unreadableDirectories].map(
      ([path, code]) => `${relative(prepared.cwd, path) || "."} (${code})`,
    );
    throw new ConfigError(`Cannot read directories: ${details.join(", ")}`);
  }
  const all = new Set(files);
  for (const path of inputs.aliases.canonical(inputs.treeFiles).values()) all.add(path);
  return [...all].toSorted();
}

/**
 * One file can be reached through several paths: a CLAUDE.md symlink to AGENTS.md, or a skill in
 * `.agents/skills` that is also linked into `.claude/skills`. This picks one path per real file,
 * so the file is linted, counted and reported once.
 */
class PathAliases {
  private readonly realPaths = new Map<string, string>();
  private readonly symlinkCounts = new Map<string, number>();
  private readonly linted = new Set<string>();
  /** Context files to the path linted in their place. */
  private readonly representatives = new Map<string, string>();

  constructor(private readonly registry: ProjectRegistry) {}

  /** Chooses the path to lint for each real file among `paths`. Returns the chosen paths, sorted. */
  selectLinted(paths: readonly string[]): string[] {
    const chosen: string[] = [];
    for (const group of this.groupByRealPath(paths, (path) => path).values()) {
      const target = this.preferred(group);
      chosen.push(target);
      this.linted.add(target);
      for (const path of group) this.representatives.set(path, target);
    }
    return chosen.toSorted();
  }

  private representative(path: string): string {
    return this.representatives.get(path) ?? path;
  }

  private groupByRealPath<T>(items: Iterable<T>, pathOf: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const real = this.realPath(pathOf(item));
      const group = groups.get(real);
      if (group) group.push(item);
      else groups.set(real, [item]);
    }
    return groups;
  }

  /** The path with symlinks resolved (cached). A broken symlink is its own file. */
  realPath(path: string): string {
    let real = this.realPaths.get(path);
    if (real === undefined) {
      real = tryRealpath(path) ?? path;
      this.realPaths.set(path, real);
    }
    return real;
  }

  /** Symlinks among the path and its ancestors inside its project. */
  private symlinkCount(path: string): number {
    let count = this.symlinkCounts.get(path);
    if (count === undefined) {
      count = 0;
      const project = this.registry.forDirectory(dirname(path));
      for (let current = path; current !== project.root && project.contains(current); current = dirname(current)) {
        if (project.isSymlink(current)) count++;
      }
      this.symlinkCounts.set(path, count);
    }
    return count;
  }

  /** A linted file first, then the path with the fewest symlinks, then the first in sort order. */
  private preferred(paths: readonly string[]): string {
    const rank = (path: string) => [this.linted.has(path) ? 0 : 1, this.symlinkCount(path)] as const;
    const sorted = paths.toSorted((x, y) => {
      const [rx, ry] = [rank(x), rank(y)];
      return rx[0] - ry[0] || rx[1] - ry[1] || (x < y ? -1 : x > y ? 1 : 0);
    });
    return sorted[0] as string;
  }

  /** Maps each path (and context files to the file linted in their place) to one path per real file. */
  canonical(paths: Iterable<string>): Map<string, string> {
    const result = new Map<string, string>();
    for (const group of this.groupByRealPath(new Set(paths), (path) => this.representative(path)).values()) {
      const target = this.preferred(group.map((path) => this.representative(path)));
      for (const path of group) result.set(path, target);
    }
    return result;
  }

  /**
   * Drops repeats of a diagnostic that was reported for the same real file through several paths,
   * keeping it at the preferred path. Diagnostics that differ by path (a name that doesn't match
   * the linked directory) stay where they were reported.
   */
  dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    const groups = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      const key = JSON.stringify([this.realPath(d.filePath), d.ruleId, d.severity, d.message, d.help, d.start, d.end]);
      const group = groups.get(key);
      if (group) group.push(d);
      else groups.set(key, [d]);
    }
    return [...groups.values()].map((group) => {
      const first = group[0] as Diagnostic;
      if (group.length > 1) first.filePath = this.preferred(group.map((d) => d.filePath));
      return first;
    });
  }
}

/**
 * What tree rules can check, such as SKILL.md files, by rule, regardless of severity. Computed once.
 * Rules that can't be enabled anywhere are only run with `includeDisabled`, to find the files they claim.
 * A rule whose `collectTreeInputs` throws (or doesn't return an array) claims nothing and gets a
 * crash diagnostic instead, if it can be enabled anywhere.
 */
function collectTreeInputs(
  inputs: DiscoveryInputs,
  registry: ProjectRegistry,
  resolver: RuleResolver,
  includeDisabled: boolean,
  cwd: string,
  timings?: RuleTimings,
): { found: Map<string, TreeInput[]>; crashes: Map<string, Diagnostic> } {
  const found = new Map<string, TreeInput[]>();
  const crashes = new Map<string, Diagnostic>();
  for (const [id, rule] of resolver.registry.rules) {
    if (!rule.collectTreeInputs || !(includeDisabled || resolver.canEnable(id))) continue;
    try {
      const context = treeDiscoveryContext(id, inputs, registry, resolver);
      const ruleInputs: unknown = timings
        ? timings.measure(id, rule.collectTreeInputs.bind(rule, context))
        : rule.collectTreeInputs(context);
      if (!Array.isArray(ruleInputs)) throw new TypeError("`collectTreeInputs` must return an array");
      found.set(id, ruleInputs as TreeInput[]);
    } catch (error) {
      if (resolver.canEnable(id)) crashes.set(id, crashDiagnostic(id, cwd, error));
    }
  }
  return { found, crashes };
}

const isEnabledAt = (resolver: RuleResolver, id: string, { path, root }: TreeInput) =>
  resolver.forFile(path, root).some((r) => r.id === id);

type DiscoveryInputs = Pick<
  TreeDiscoveryContext<unknown[]>,
  "directories" | "directoryInputs" | "explicitFiles" | "isIgnored" | "isContextFile"
>;

function collectInputs(options: LintOptions, prepared: LintSetup, registry: ProjectRegistry) {
  const { cwd, config } = prepared;
  const ignores: PatternIgnore[] = [];
  if (!options.noIgnore) {
    if (config.ignorePatterns.length) ignores.push(new PatternIgnore(config.dir, config.ignorePatterns));
    if (options.ignorePatterns?.length) ignores.push(new PatternIgnore(cwd, options.ignorePatterns));
    const ignoreFile = resolve(cwd, options.ignorePath ?? DEFAULT_IGNORE_FILE);
    if (existsSync(ignoreFile)) {
      ignores.push(new PatternIgnore(dirname(ignoreFile), readIgnoreFile(ignoreFile)));
    } else if (options.ignorePath) {
      throw new ConfigError(`Ignore file not found: ${options.ignorePath}`);
    }
  }

  const isIgnored: DiscoveryInputs["isIgnored"] = (absPath, isDir, { gitignore = true } = {}) => {
    const project = registry.forDirectory(dirname(absPath));
    if (
      project
        .relative(absPath)
        .split("/")
        .some((s) => ALWAYS_SKIPPED_DIRS.has(s))
    )
      return true;
    return (
      !options.noIgnore &&
      ((gitignore && project.gitignore.isIgnored(absPath, isDir)) || ignores.some((ig) => ig.isIgnored(absPath, isDir)))
    );
  };

  const discovery = discoverFiles({
    cwd,
    paths: options.paths ?? [],
    filePatterns: config.files,
    patternBase: config.dir,
    ignores,
    noIgnore: options.noIgnore ?? false,
    registry,
  });
  if (discovery.missing.length) {
    throw new ConfigError(`No such file or directory: ${discovery.missing.join(", ")}`);
  }

  // A file named on the command line is checked as it would be when found by scanning: a SKILL.md
  // gets only the tree rules that check skills, unless it also matches the context file patterns.
  const isContextFile = (path: string) => config.files.some((pattern) => matchesFilePattern(pattern, config.dir, path));
  const discoveryInputs: DiscoveryInputs = {
    directories: discovery.directories,
    directoryInputs: discovery.directoryInputs,
    explicitFiles: discovery.explicitFiles,
    isIgnored,
    isContextFile,
  };
  const hasOtherExplicitFiles = discovery.explicitFiles.some((path) => !isContextFile(path));
  const { found, crashes: treeCrashes } = collectTreeInputs(
    discoveryInputs,
    registry,
    prepared.resolver,
    hasOtherExplicitFiles,
    cwd,
    options.ruleTimings,
  );
  const treeInputs = new Map<string, TreeInput[]>();
  for (const [id, ruleInputs] of found) {
    treeInputs.set(
      id,
      ruleInputs.filter((input) => isEnabledAt(prepared.resolver, id, input)),
    );
  }
  const treeFiles = [...treeInputs.values()].flat().map(({ path }) => path);
  let contextFiles = discovery.files;
  /** Named files that only tree rules that are off for them would check, with those rules. */
  const uncheckedFiles = new Map<string, string[]>();
  if (hasOtherExplicitFiles) {
    // Claimed even where the tree rule is off: turning one rule off must not turn others on.
    const claimedBy = new Map<string, string[]>();
    for (const [id, ruleInputs] of found) {
      for (const { path } of ruleInputs) claimedBy.set(path, [...(claimedBy.get(path) ?? []), id]);
    }
    contextFiles = contextFiles.filter((path) => !claimedBy.has(path) || isContextFile(path));
    const checked = new Set(treeFiles);
    for (const path of discovery.explicitFiles) {
      const rules = claimedBy.get(path);
      if (rules && !isContextFile(path) && !checked.has(path)) uncheckedFiles.set(path, rules);
    }
  }

  // Lint each real file once: symlinked duplicates (CLAUDE.md -> AGENTS.md) would only repeat diagnostics.
  const aliases = new PathAliases(registry);
  return {
    ...discoveryInputs,
    files: aliases.selectLinted(contextFiles),
    contextFiles,
    treeInputs,
    treeCrashes,
    treeFiles,
    aliases,
    uncheckedFiles,
    ignoredFiles: discovery.ignoredFiles,
    unreadableDirectories: discovery.unreadableDirectories,
  };
}

function treeDiscoveryContext(
  id: string,
  inputs: DiscoveryInputs,
  registry: ProjectRegistry,
  resolver: RuleResolver,
): TreeDiscoveryContext<unknown[]> {
  return {
    directories: inputs.directories,
    directoryInputs: inputs.directoryInputs,
    explicitFiles: inputs.explicitFiles,
    isIgnored: inputs.isIgnored,
    isContextFile: inputs.isContextFile,
    projectFor: (dir) => registry.forDirectory(dir),
    optionsFor: (path, root) => resolver.optionsFor(id, path, root),
    discoveryOptions: resolver.discoveryOptions(id),
  };
}

/**
 * Runs the `checkTree` hook of every rule once over the discovered directories.
 * Severity and options are resolved per reported path, so `overrides` apply.
 */
async function lintTree(
  inputs: ReturnType<typeof collectInputs>,
  registry: ProjectRegistry,
  resolver: RuleResolver,
  cwd: string,
  directives: DirectiveCache,
  timings?: RuleTimings,
) {
  // Rules whose `collectTreeInputs` crashed don't run `checkTree`: they report the crash instead.
  const diagnostics: Diagnostic[] = [...inputs.treeCrashes.values()];
  const checked = new Set<string>();
  const enabledRules = new Set<string>();
  /** The rules that checked each file, by real path. */
  const checkedBy = new Map<string, Set<string>>();
  // Overrides matching the root an input was found in apply to everything reported at its path.
  const rootsByRule = new Map(
    [...inputs.treeInputs].map(([id, ruleInputs]) => [
      id,
      new Map(ruleInputs.flatMap(({ path, root }) => (root ? [[path, root] as const] : []))),
    ]),
  );
  const settingFor = (ruleId: string, path: string) =>
    resolver.forFile(path, rootsByRule.get(ruleId)?.get(path)).find((r) => r.id === ruleId);
  const treeRules = [...resolver.registry.rules].filter(
    ([id, rule]) => rule.checkTree && resolver.canEnable(id) && !inputs.treeCrashes.has(id),
  );
  await Promise.all(
    treeRules.map(async ([ruleId, rule]) => {
      const markChecked = (path: string) => {
        checked.add(path);
        enabledRules.add(ruleId);
        const realPath = inputs.aliases.realPath(path);
        const rules = checkedBy.get(realPath);
        if (rules) rules.add(ruleId);
        else checkedBy.set(realPath, new Set([ruleId]));
      };
      const isSuppressed = (path: string, start: Position) => {
        const realPath = inputs.aliases.realPath(path);
        return suppresses(
          treeFileDirectives(path, realPath, registry, resolver.registry, directives),
          ruleId,
          start.line,
        );
      };
      try {
        const context: TreeContext<unknown[]> = {
          ...treeDiscoveryContext(ruleId, inputs, registry, resolver),
          cwd,
          contextFiles: inputs.contextFiles,
          treeInputs: inputs.treeInputs.get(ruleId) ?? [],
          isEnabled: (path) => settingFor(ruleId, path) !== undefined,
          isSuppressed,
          markChecked(path) {
            if (settingFor(ruleId, path)) markChecked(path);
          },
          report(filePath, descriptor) {
            const setting = settingFor(ruleId, filePath);
            if (!setting) return;
            markChecked(filePath);
            const diagnostic = toDiagnostic(setting, filePath, descriptor, { line: 1, column: 1 });
            if (!isSuppressed(filePath, diagnostic.start)) diagnostics.push(diagnostic);
          },
        };
        await (timings ? timings.measure(ruleId, () => rule.checkTree?.(context)) : rule.checkTree?.(context));
      } catch (error) {
        diagnostics.push(crashDiagnostic(ruleId, cwd, error));
      }
    }),
  );
  const { aliases } = inputs;
  const checkedFiles = new Set(aliases.canonical(checked).values());
  return { diagnostics: aliases.dedupe(diagnostics), checkedFiles, enabledRules, checkedBy };
}

/**
 * Adds diagnostics to the result of their file, creating results for files that were not linted.
 * A real file reached through several paths keeps one result per path with diagnostics, or a
 * single empty result when it has none.
 */
function mergeDiagnostics(
  files: readonly FileResult[],
  diagnostics: readonly Diagnostic[],
  checkedFiles: ReadonlySet<string>,
  realPath: (path: string) => string,
): FileResult[] {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  const resultFor = (path: string) => {
    let file = byPath.get(path);
    if (!file) {
      file = { filePath: path, diagnostics: [] };
      byPath.set(path, file);
    }
    return file;
  };
  for (const path of checkedFiles) resultFor(path);
  for (const d of diagnostics) resultFor(d.filePath).diagnostics.push(d);
  const results = [...byPath.values()];
  const reported = new Set(results.filter((f) => f.diagnostics.length).map((f) => realPath(f.filePath)));
  for (const file of results) {
    file.diagnostics.sort(
      (a, b) =>
        a.start.line - b.start.line ||
        a.start.column - b.start.column ||
        (a.ruleId ?? "").localeCompare(b.ruleId ?? ""),
    );
  }
  return results
    .filter((f) => f.diagnostics.length || !reported.has(realPath(f.filePath)))
    .toSorted((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
}

/** Lints context files according to `options`. Throws {@link ConfigError} for invalid configuration. */
export async function lint(options: LintOptions = {}, prepared?: LintSetup): Promise<LintResult> {
  const startedAt = performance.now();
  const ready = prepared ?? (await setup(options));
  const registry = new ProjectRegistry(ready.cwd);
  const inputs = collectInputs(options, ready, registry);
  const { files: paths, ignoredFiles, uncheckedFiles, unreadableDirectories } = inputs;
  const { resolver } = ready;

  const enabledRules = new Set<string>();
  /** The per-file rules run on each linted file. */
  const fileRules = new Map<string, string[]>();
  const directives: DirectiveCache = new Map();
  // The tree pass runs while per-file rules wait on I/O (such as Git processes). Files are parsed
  // (and their directives cached) before the first await, so the tree pass reuses them.
  const [linted, tree] = await Promise.all([
    Promise.all(
      paths.map(async (path): Promise<FileResult> => {
        const rules = resolver.forFile(path).filter(({ rule }) => rule.create || rule.createOnce);
        const checking = rules.map((r) => r.id);
        fileRules.set(path, checking);
        // Tree rules count once they check something (see `tree.enabledRules`).
        for (const name of checking) enabledRules.add(name);
        const project = registry.forDirectory(dirname(path));
        return {
          filePath: path,
          diagnostics: await lintFile(path, project, rules, ready, directives, options.ruleTimings),
        };
      }),
    ),
    lintTree(inputs, registry, resolver, ready.cwd, directives, options.ruleTimings),
  ]);
  const realPath = (path: string) => inputs.aliases.realPath(path);
  const lintedFiles = new Set(paths.map(realPath));
  // `lintFile` reports unknown rules in the directives of context files; these are the ones in files
  // that only tree rules check, such as SKILL.md.
  const treeOnlyFiles = [...tree.checkedFiles].filter((path) => !lintedFiles.has(realPath(path)));
  const fileDirectives = (path: string) =>
    treeFileDirectives(path, realPath(path), registry, resolver.registry, directives);
  const directiveNotes = treeOnlyFiles.flatMap((path) =>
    unknownRuleDiagnostics(path, fileDirectives(path), resolver.registry),
  );
  // Both passes have recorded which directives suppressed something.
  if (ready.config.reportUnnecessarySuppressions) {
    for (const path of [...paths, ...treeOnlyFiles]) {
      const real = realPath(path);
      const checkedBy = new Set([...(fileRules.get(path) ?? []), ...(tree.checkedBy.get(real) ?? [])]);
      directiveNotes.push(
        ...unnecessarySuppressionDiagnostics(path, fileDirectives(path), checkedBy, resolver.registry),
      );
    }
  }
  const files = mergeDiagnostics(linted, [...tree.diagnostics, ...directiveNotes], tree.checkedFiles, realPath);
  const fileCount = new Set([...paths, ...tree.checkedFiles]).size;
  for (const rule of tree.enabledRules) enabledRules.add(rule);
  for (const path of [...unreadableDirectories.keys()].toSorted()) {
    files.push({
      filePath: path,
      diagnostics: [fileDiagnostic(path, `Cannot read directory (${unreadableDirectories.get(path)})`)],
    });
  }
  for (const path of ignoredFiles) {
    files.push({
      filePath: path,
      diagnostics: [
        {
          ...fileDiagnostic(path, "File skipped because it matches an ignore pattern", "warn"),
          help: "Use `--no-ignore` to lint this file.",
        },
      ],
    });
  }
  for (const [path, rules] of uncheckedFiles) {
    const names = rules.map((rule) => `\`${rule}\``).join(", ");
    files.push({
      filePath: path,
      diagnostics: [
        {
          ...fileDiagnostic(
            path,
            `File skipped because ${names} ${rules.length > 1 ? "are" : "is"} off for it`,
            "warn",
          ),
          help: "Enable the rule for this file to check it.",
        },
      ],
    });
  }
  if (fileCount === 0) for (const r of resolver.baseRules()) enabledRules.add(r.id);

  let errorCount = 0;
  let warningCount = 0;
  for (const file of files) {
    for (const d of file.diagnostics) {
      if (d.severity === "error") errorCount++;
      else if (d.severity === "warn") warningCount++;
    }
  }
  return {
    files,
    fileCount,
    ruleCount: enabledRules.size,
    errorCount,
    warningCount,
    durationMs: performance.now() - startedAt,
  };
}
