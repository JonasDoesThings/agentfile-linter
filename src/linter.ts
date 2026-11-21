import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { RULES } from "#src/rules/index.ts";

import {
  type CliRuleFlag,
  type Config,
  ConfigError,
  type EnabledRule,
  emptyConfig,
  findConfigFile,
  loadConfigFile,
  matchesFilePattern,
  RuleResolver,
} from "./config.ts";
import { discoverFiles } from "./discovery.ts";
import { PatternIgnore } from "./gitignore.ts";
import { computeLineStarts, parseMarkdown } from "./markdown.ts";
import { ALWAYS_SKIPPED_DIRS, type Project, ProjectRegistry, tryRealpath } from "./project.ts";
import { applySuppressions, collectDirectives, type Directive, unknownRuleDiagnostics } from "./suppressions.ts";
import type {
  AnyRule,
  Diagnostic,
  FileResult,
  LintedFile,
  LintResult,
  Position,
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
}

export interface LintSetup {
  cwd: string;
  config: Config;
  resolver: RuleResolver;
}

/** Loads the configuration and validates CLI rule flags. Throws {@link ConfigError}. */
export function setup(options: LintOptions = {}): LintSetup {
  const cwd = resolve(options.cwd ?? process.cwd());
  let config: Config;
  if (options.config === false) {
    config = emptyConfig(cwd);
  } else if (options.config) {
    const path = resolve(cwd, options.config);
    if (!existsSync(path)) throw new ConfigError(`Config file not found: ${options.config}`);
    config = loadConfigFile(path);
  } else {
    const found = findConfigFile(cwd);
    config = found ? loadConfigFile(found) : emptyConfig(cwd);
  }
  return { cwd, config, resolver: new RuleResolver(config, options.ruleFlags) };
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
function treeFileDirectives(path: string, realPath: string, registry: ProjectRegistry, cache: DirectiveCache) {
  let directives = cache.get(realPath);
  if (!directives) {
    const project = registry.forDirectory(dirname(path));
    const text = project.isFile(path) ? project.readText(path) : null;
    directives =
      text === null || !text.includes("agentfile-linter-") ? [] : collectDirectives({ text, ast: parseMarkdown(text) });
    cache.set(realPath, directives);
  }
  return directives;
}

/** Runs the given rules over one file. */
export async function lintFile(
  path: string,
  project: Project,
  rules: EnabledRule[],
  directiveCache?: DirectiveCache,
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
  const file: LintedFile = { path, realPath, text, ast: parseMarkdown(text), lineStarts: computeLineStarts(text) };
  const directives = collectDirectives(file);
  directiveCache?.set(realPath, directives);
  const diagnostics: Diagnostic[] = [];
  // Rules are independent; diagnostics are sorted below, so completion order doesn't matter.
  const runRule = async ({ rule, severity, options }: EnabledRule) => {
    if (!rule.check) return;
    try {
      await rule.check({
        file,
        project,
        options,
        report(descriptor) {
          diagnostics.push({
            ruleId: rule.meta.name,
            severity,
            message: descriptor.message,
            help: descriptor.help,
            filePath: path,
            start: descriptor.start,
            end: descriptor.end ?? descriptor.start,
          });
        },
      });
    } catch (error) {
      diagnostics.push({
        ...fileDiagnostic(path, `Rule crashed: ${(error as Error).stack ?? String(error)}`),
        ruleId: rule.meta.name,
      });
    }
  };
  await Promise.all(rules.map(runRule));
  const kept = [...applySuppressions(diagnostics, directives), ...unknownRuleDiagnostics(path, directives)];
  return kept.toSorted((a, b) => a.start.line - b.start.line || a.start.column - b.start.column);
}

/**
 * Discovers the files `lint` would check, including additional rule inputs.
 * Ignored files are excluded and the returned absolute paths are sorted.
 */
export function collectFiles(
  options: LintOptions,
  prepared: LintSetup = setup(options),
  registry: ProjectRegistry = new ProjectRegistry(prepared.cwd),
): string[] {
  const inputs = collectInputs(options, prepared, registry);
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
 */
function collectTreeInputs(
  inputs: DiscoveryInputs,
  registry: ProjectRegistry,
  resolver: RuleResolver,
  includeDisabled: boolean,
): Map<AnyRule, TreeInput[]> {
  const treeInputs = new Map<AnyRule, TreeInput[]>();
  for (const rule of RULES.values()) {
    if (!rule.collectTreeInputs || !(includeDisabled || resolver.canEnable(rule))) continue;
    treeInputs.set(rule, rule.collectTreeInputs(treeDiscoveryContext(rule, inputs, registry, resolver)));
  }
  return treeInputs;
}

const isEnabledAt = (resolver: RuleResolver, rule: AnyRule, { path, root }: TreeInput) =>
  resolver.forFile(path, root).some((r) => r.rule === rule);

type DiscoveryInputs = Pick<
  TreeDiscoveryContext<unknown>,
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

  const isIgnored = (absPath: string, isDir: boolean): boolean => {
    const project = registry.forDirectory(dirname(absPath));
    if (options.noIgnore)
      return project
        .relative(absPath)
        .split("/")
        .some((s) => ALWAYS_SKIPPED_DIRS.has(s));
    return project.isIgnored(absPath, isDir) || ignores.some((ig) => ig.isIgnored(absPath, isDir));
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
  const found = collectTreeInputs(discoveryInputs, registry, prepared.resolver, hasOtherExplicitFiles);
  const treeInputs = new Map<AnyRule, TreeInput[]>();
  for (const [rule, ruleInputs] of found) {
    treeInputs.set(
      rule,
      ruleInputs.filter((input) => isEnabledAt(prepared.resolver, rule, input)),
    );
  }
  const treeFiles = [...treeInputs.values()].flat().map(({ path }) => path);
  let contextFiles = discovery.files;
  /** Named files that only tree rules that are off for them would check, with those rules. */
  const uncheckedFiles = new Map<string, string[]>();
  if (hasOtherExplicitFiles) {
    // Claimed even where the tree rule is off: turning one rule off must not turn others on.
    const claimedBy = new Map<string, string[]>();
    for (const [rule, ruleInputs] of found) {
      for (const { path } of ruleInputs) claimedBy.set(path, [...(claimedBy.get(path) ?? []), rule.meta.name]);
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
    treeFiles,
    aliases,
    uncheckedFiles,
    ignoredFiles: discovery.ignoredFiles,
    unreadableDirectories: discovery.unreadableDirectories,
  };
}

function treeDiscoveryContext(
  rule: AnyRule,
  inputs: DiscoveryInputs,
  registry: ProjectRegistry,
  resolver: RuleResolver,
): TreeDiscoveryContext<Record<string, unknown>> {
  return {
    directories: inputs.directories,
    directoryInputs: inputs.directoryInputs,
    explicitFiles: inputs.explicitFiles,
    isIgnored: inputs.isIgnored,
    isContextFile: inputs.isContextFile,
    projectFor: (dir) => registry.forDirectory(dir),
    optionsFor: (path, root) => resolver.optionsFor(rule, path, root),
    discoveryOptions: resolver.discoveryOptions(rule),
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
) {
  const diagnostics: Diagnostic[] = [];
  const checked = new Set<string>();
  const enabledRules = new Set<string>();
  // Overrides matching the root an input was found in apply to everything reported at its path.
  const rootsByRule = new Map(
    [...inputs.treeInputs].map(([rule, ruleInputs]) => [
      rule,
      new Map(ruleInputs.flatMap(({ path, root }) => (root ? [[path, root] as const] : []))),
    ]),
  );
  const settingFor = (rule: AnyRule, path: string) =>
    resolver.forFile(path, rootsByRule.get(rule)?.get(path)).find((r) => r.rule === rule);
  const treeRules = [...RULES.values()].filter((rule) => rule.checkTree !== undefined && resolver.canEnable(rule));
  await Promise.all(
    treeRules.map(async (rule) => {
      const ruleId = rule.meta.name;
      const markChecked = (path: string) => {
        checked.add(path);
        enabledRules.add(ruleId);
      };
      const isSuppressed = (path: string, start: Position) => {
        const fileDirectives = treeFileDirectives(path, inputs.aliases.realPath(path), registry, directives);
        const problem = { ...fileDiagnostic(path, ""), ruleId, start, end: start };
        return applySuppressions([problem], fileDirectives).length === 0;
      };
      try {
        await rule.checkTree?.({
          ...treeDiscoveryContext(rule, inputs, registry, resolver),
          cwd,
          contextFiles: inputs.contextFiles,
          treeInputs: inputs.treeInputs.get(rule) ?? [],
          isEnabled: (path) => settingFor(rule, path) !== undefined,
          isSuppressed,
          markChecked(path) {
            if (settingFor(rule, path)) markChecked(path);
          },
          report(filePath, descriptor) {
            const setting = settingFor(rule, filePath);
            if (!setting) return;
            markChecked(filePath);
            if (isSuppressed(filePath, descriptor.start)) return;
            diagnostics.push({
              ruleId,
              severity: setting.severity,
              message: descriptor.message,
              help: descriptor.help,
              filePath,
              start: descriptor.start,
              end: descriptor.end ?? descriptor.start,
            });
          },
        });
      } catch (error) {
        diagnostics.push({
          ...fileDiagnostic(cwd, `Rule crashed: ${(error as Error).stack ?? String(error)}`),
          ruleId,
        });
      }
    }),
  );
  const { aliases } = inputs;
  const checkedFiles = new Set(aliases.canonical(checked).values());
  return { diagnostics: aliases.dedupe(diagnostics), checkedFiles, enabledRules };
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
  const ready = prepared ?? setup(options);
  const registry = new ProjectRegistry(ready.cwd);
  const inputs = collectInputs(options, ready, registry);
  const { files: paths, ignoredFiles, uncheckedFiles, unreadableDirectories } = inputs;
  const { resolver } = ready;

  const enabledRules = new Set<string>();
  const directives: DirectiveCache = new Map();
  // The tree pass runs while per-file rules wait on I/O (such as Git processes). Files are parsed
  // (and their directives cached) before the first await, so the tree pass reuses them.
  const [linted, tree] = await Promise.all([
    Promise.all(
      paths.map(async (path): Promise<FileResult> => {
        const rules = resolver.forFile(path);
        // Tree rules count once they check something (see `tree.enabledRules`).
        for (const r of rules) if (r.rule.check) enabledRules.add(r.rule.meta.name);
        const project = registry.forDirectory(dirname(path));
        return { filePath: path, diagnostics: await lintFile(path, project, rules, directives) };
      }),
    ),
    lintTree(inputs, registry, resolver, ready.cwd, directives),
  ]);
  // Directives in context files are checked by `lintFile`; these are the ones in files that only
  // tree rules check, such as SKILL.md.
  const realPath = (path: string) => inputs.aliases.realPath(path);
  const lintedFiles = new Set(paths.map(realPath));
  const directiveNotes = [...tree.checkedFiles]
    .filter((path) => !lintedFiles.has(realPath(path)))
    .flatMap((path) => unknownRuleDiagnostics(path, treeFileDirectives(path, realPath(path), registry, directives)));
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
  if (fileCount === 0) for (const r of resolver.baseRules()) enabledRules.add(r.rule.meta.name);

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
