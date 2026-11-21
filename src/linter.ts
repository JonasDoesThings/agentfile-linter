import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import {
  type CliRuleFlag,
  type Config,
  ConfigError,
  type EnabledRule,
  emptyConfig,
  findConfigFile,
  loadConfigFile,
  RuleResolver,
} from "./config.ts";
import { discoverFiles } from "./discovery.ts";
import { PatternIgnore } from "./gitignore.ts";
import { computeLineStarts, parseMarkdown } from "./markdown.ts";
import { type Project, ProjectRegistry } from "./project.ts";
import { applySuppressions, collectDirectives } from "./suppressions.ts";
import type { Diagnostic, FileResult, LintedFile, LintResult, Position } from "./types.ts";

export const DEFAULT_IGNORE_FILE = ".contextlintignore";

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
  /** Ignore file (defaults to `.contextlintignore` in cwd, if present). */
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

/** Runs the given rules over one file. */
export async function lintFile(path: string, project: Project, rules: EnabledRule[]): Promise<Diagnostic[]> {
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
  const diagnostics: Diagnostic[] = [];
  // Rules are independent; diagnostics are sorted below, so completion order doesn't matter.
  const runRule = async ({ rule, severity, options }: EnabledRule) => {
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
  const kept = applySuppressions(diagnostics, collectDirectives(file));
  return kept.toSorted((a, b) => a.start.line - b.start.line || a.start.column - b.start.column);
}

/**
 * Discovers the files `lint` would check: context files below the given paths,
 * minus ignored files, with symlinked duplicates collapsed. Sorted, absolute.
 */
export function collectFiles(
  options: LintOptions,
  prepared: LintSetup = setup(options),
  registry: ProjectRegistry = new ProjectRegistry(prepared.cwd),
): string[] {
  const { files, unreadableDirectories } = collectInputs(options, prepared, registry);
  if (unreadableDirectories.size) {
    const details = [...unreadableDirectories].map(
      ([path, code]) => `${relative(prepared.cwd, path) || "."} (${code})`,
    );
    throw new ConfigError(`Cannot read directories: ${details.join(", ")}`);
  }
  return files;
}

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

  // Lint each real file once: symlinked duplicates (CLAUDE.md -> AGENTS.md) would only repeat diagnostics.
  const byRealPath = new Map<string, string>();
  for (const path of discovery.files) {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = path; // broken symlink: keep it so it gets reported
    }
    const existing = byRealPath.get(real);
    const project = registry.forDirectory(dirname(path));
    if (!existing || (project.isSymlink(existing) && !project.isSymlink(path))) byRealPath.set(real, path);
  }
  return {
    files: [...byRealPath.values()].toSorted(),
    ignoredFiles: discovery.ignoredFiles,
    unreadableDirectories: discovery.unreadableDirectories,
  };
}

/** Lints context files according to `options`. Throws {@link ConfigError} for invalid configuration. */
export async function lint(options: LintOptions = {}, prepared?: LintSetup): Promise<LintResult> {
  const startedAt = performance.now();
  const ready = prepared ?? setup(options);
  const registry = new ProjectRegistry(ready.cwd);
  const { files: paths, ignoredFiles, unreadableDirectories } = collectInputs(options, ready, registry);
  const { resolver } = ready;

  const enabledRules = new Set<string>();
  const files: FileResult[] = await Promise.all(
    paths.map(async (path) => {
      const rules = resolver.forFile(path);
      for (const r of rules) enabledRules.add(r.rule.meta.name);
      const project = registry.forDirectory(dirname(path));
      return { filePath: path, diagnostics: await lintFile(path, project, rules) };
    }),
  );
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
  if (paths.length === 0) for (const r of resolver.baseRules()) enabledRules.add(r.rule.meta.name);

  let errorCount = 0;
  let warningCount = 0;
  for (const file of files) {
    for (const d of file.diagnostics) {
      if (d.severity === "error") errorCount++;
      else warningCount++;
    }
  }
  return {
    files,
    fileCount: paths.length,
    ruleCount: enabledRules.size,
    errorCount,
    warningCount,
    durationMs: performance.now() - startedAt,
  };
}
