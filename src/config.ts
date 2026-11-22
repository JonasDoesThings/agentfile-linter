import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { BUILTIN_RULES, RuleRegistry } from "#src/rules/index.ts";

import { toPosix } from "./gitignore.ts";
import { Glob } from "./glob.ts";
import { parseJsonc } from "./jsonc.ts";
import { loadPlugins, loadPluginsSettled, type PluginEntry } from "./plugins.ts";
import { acceptsOptions, validateOptions } from "./schema.ts";
import { type AnyRule, CATEGORIES, type Category, DEFAULT_FILE_PATTERNS, type Plugin, type Severity } from "./types.ts";
import { deepFreeze, isRecord } from "./util.ts";

export const CONFIG_FILE_NAMES = [".agentfile-linterrc.json", ".agentfile-linterrc.jsonc"];

/** Context files linted when the config doesn't specify `files`. */
export { DEFAULT_FILE_PATTERNS };

const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "jsPlugins",
  "files",
  "categories",
  "rules",
  "overrides",
  "ignorePatterns",
  "settings",
  "reportUnnecessarySuppressions",
]);
const OVERRIDE_KEYS = new Set(["files", "jsPlugins", "rules"]);

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface RuleSetting {
  severity: Severity;
  /** What follows the severity, if anything. */
  options?: unknown[];
}

export interface Override {
  files: string[];
  jsPlugins: PluginEntry[];
  rules: Map<string, RuleSetting>;
}

export interface Config {
  /** Absolute path of the config file, or null when running without one. */
  path: string | null;
  /** Base directory for `files`, `overrides[].files`, `ignorePatterns` and `jsPlugins`. */
  dir: string;
  /** The built-in rules and those of the loaded `jsPlugins`. */
  registry: RuleRegistry;
  jsPlugins: PluginEntry[];
  files: string[];
  categories: Map<Category, Severity>;
  rules: Map<string, RuleSetting>;
  overrides: Override[];
  ignorePatterns: string[];
  /** Passed to every rule as `context.settings`. */
  settings: Record<string, unknown>;
  /** Report inline directives that suppress nothing. */
  reportUnnecessarySuppressions: boolean;
}

export function emptyConfig(dir: string): Config {
  return {
    path: null,
    dir,
    registry: BUILTIN_RULES,
    jsPlugins: [],
    files: DEFAULT_FILE_PATTERNS,
    categories: new Map(),
    rules: new Map(),
    overrides: [],
    ignorePatterns: [],
    settings: {},
    reportUnnecessarySuppressions: true,
  };
}

export function normalizeSeverity(value: unknown): Severity | undefined {
  switch (value) {
    case "off":
    case "allow":
    case 0:
      return "off";
    case "warn":
    case 1:
      return "warn";
    case "error":
    case "deny":
    case 2:
      return "error";
    default:
      return undefined;
  }
}

function suggestRule(registry: RuleRegistry, name: string): string {
  const rule = registry.suggest(name);
  return rule ? ` Did you mean "${rule}"?` : "";
}

/**
 * Merges a layer of options over earlier ones, as ESLint merges options over `meta.defaultOptions`:
 * objects key by key, other values replaced.
 */
export function mergeOptions(base: readonly unknown[], layer: readonly unknown[]): unknown[] {
  const mergeValue = (a: unknown, b: unknown): unknown =>
    isRecord(a) && isRecord(b)
      ? Object.fromEntries([
          ...Object.entries(a),
          ...Object.entries(b).map(([key, value]) => [
            key,
            mergeValue(Object.hasOwn(a, key) ? a[key] : undefined, value),
          ]),
        ])
      : b;
  return Array.from({ length: Math.max(base.length, layer.length) }, (_, i) =>
    i < layer.length ? mergeValue(base[i], layer[i]) : base[i],
  );
}

function parseRuleSetting(registry: RuleRegistry, name: string, value: unknown, where: string): [string, RuleSetting] {
  const ruleName = registry.resolve(name);
  if (!ruleName) throw new ConfigError(`${where}: unknown rule "${name}".${suggestRule(registry, name)}`);
  const meta = (registry.get(ruleName) as AnyRule).meta;
  const [severityInput, ...options] = Array.isArray(value) ? value : [value];
  const severity = normalizeSeverity(severityInput);
  if (!severity) {
    throw new ConfigError(
      `${where}: invalid severity ${JSON.stringify(severityInput)} for "${name}" (expected "off", "warn" or "error")`,
    );
  }
  if (options.length === 0) return [ruleName, { severity }];
  if (!acceptsOptions(meta?.schema)) throw new ConfigError(`${where}: rule "${ruleName}" has no options`);
  // As in ESLint, the options are validated with the defaults filled in.
  const problems = validateOptions(meta.schema, mergeOptions(meta.defaultOptions ?? [], options));
  if (problems.length) throw new ConfigError(`${where}: invalid options for "${ruleName}": ${problems.join("; ")}`);
  return [ruleName, { severity, options }];
}

function parseRules(registry: RuleRegistry, value: unknown, where: string): Map<string, RuleSetting> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  return new Map(Object.entries(value).map(([name, setting]) => parseRuleSetting(registry, name, setting, where)));
}

function parseStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return value;
}

const isPluginEntry = (entry: unknown): entry is PluginEntry =>
  typeof entry === "string" ||
  (isRecord(entry) &&
    typeof entry.name === "string" &&
    typeof entry.specifier === "string" &&
    Object.keys(entry).length === 2);

function parsePluginEntries(value: unknown, where: string): PluginEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPluginEntry)) {
    throw new ConfigError(
      `${where} must be an array of plugin paths, package names or { "name", "specifier" } objects`,
    );
  }
  return value;
}

const configLabel = (path: string | null) => (path ? relative(process.cwd(), path) || path : "config");

/**
 * Validates and normalizes a parsed config object. `plugins` are its loaded `jsPlugins` by name
 * (see {@link loadConfig}).
 */
export function parseConfig(
  raw: unknown,
  path: string | null,
  dir: string,
  plugins: ReadonlyMap<string, Plugin> = new Map(),
): Config {
  const label = configLabel(path);
  if (!isRecord(raw)) throw new ConfigError(`${label}: config must be a JSON object`);
  const registry = plugins.size ? new RuleRegistry(plugins) : BUILTIN_RULES;
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(`${label}: unknown property "${key}" (allowed: ${[...TOP_LEVEL_KEYS].join(", ")})`);
    }
  }

  const categories = new Map<Category, Severity>();
  if (raw.categories !== undefined) {
    if (!isRecord(raw.categories)) throw new ConfigError(`${label}: "categories" must be an object`);
    for (const [name, value] of Object.entries(raw.categories)) {
      if (!(CATEGORIES as readonly string[]).includes(name)) {
        throw new ConfigError(`${label}: unknown category "${name}" (available: ${CATEGORIES.join(", ")})`);
      }
      const severity = normalizeSeverity(value);
      if (!severity)
        throw new ConfigError(`${label}: invalid severity ${JSON.stringify(value)} for category "${name}"`);
      categories.set(name as Category, severity);
    }
  }

  const overrides: Override[] = [];
  if (raw.overrides !== undefined) {
    if (!Array.isArray(raw.overrides)) throw new ConfigError(`${label}: "overrides" must be an array`);
    raw.overrides.forEach((entry, i) => {
      const where = `${label}: overrides[${i}]`;
      if (!isRecord(entry)) throw new ConfigError(`${where} must be an object`);
      for (const key of Object.keys(entry)) {
        if (!OVERRIDE_KEYS.has(key)) throw new ConfigError(`${where}: unknown property "${key}"`);
      }
      const files = parseStringArray(entry.files, `${where}.files`);
      if (!files?.length) throw new ConfigError(`${where}.files must be a non-empty array of glob patterns`);
      overrides.push({
        files,
        jsPlugins: parsePluginEntries(entry.jsPlugins, `${where}.jsPlugins`),
        rules: parseRules(registry, entry.rules, `${where}.rules`),
      });
    });
  }

  const files = parseStringArray(raw.files, `${label}: "files"`);
  if (files && files.length === 0) throw new ConfigError(`${label}: "files" must not be empty`);

  const reportUnnecessarySuppressions = raw.reportUnnecessarySuppressions ?? true;
  if (typeof reportUnnecessarySuppressions !== "boolean") {
    throw new ConfigError(`${label}: "reportUnnecessarySuppressions" must be a boolean`);
  }
  const settings = raw.settings ?? {};
  if (!isRecord(settings)) throw new ConfigError(`${label}: "settings" must be an object`);

  return {
    path,
    dir,
    registry,
    jsPlugins: parsePluginEntries(raw.jsPlugins, `${label}: "jsPlugins"`),
    files: files ?? DEFAULT_FILE_PATTERNS,
    categories,
    rules: parseRules(registry, raw.rules, `${label}: "rules"`),
    overrides,
    ignorePatterns: parseStringArray(raw.ignorePatterns, `${label}: "ignorePatterns"`) ?? [],
    settings,
    reportUnnecessarySuppressions,
  };
}

/** The `jsPlugins` entries of a parsed config object, including those of its overrides. */
function pluginEntries(raw: unknown, label: string): PluginEntry[] {
  if (!isRecord(raw)) return [];
  return [
    ...parsePluginEntries(raw.jsPlugins, `${label}: "jsPlugins"`),
    ...(Array.isArray(raw.overrides) ? raw.overrides : []).flatMap((entry, i) =>
      isRecord(entry) ? parsePluginEntries(entry.jsPlugins, `${label}: overrides[${i}].jsPlugins`) : [],
    ),
  ];
}

/**
 * Loads the `jsPlugins` of a parsed config object (also those of its overrides), resolved against
 * `dir`, then validates and normalizes the config with their rules.
 */
export async function loadConfig(raw: unknown, path: string | null, dir: string): Promise<Config> {
  const label = configLabel(path);
  const entries = pluginEntries(raw, label);
  let plugins: Map<string, Plugin>;
  try {
    plugins = await loadPlugins(entries, dir);
  } catch (error) {
    throw new ConfigError(`${label}: ${(error as Error).message}`);
  }
  return parseConfig(raw, path, dir, plugins);
}

/** Reads and parses a config file, without validating it. */
function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  try {
    return parseJsonc(text);
  } catch (error) {
    throw new ConfigError(`Failed to parse ${path}: ${(error as Error).message}`);
  }
}

export async function loadConfigFile(path: string): Promise<Config> {
  return loadConfig(readConfigFile(path), path, dirname(path));
}

/**
 * The rules available with a config file (or none), for `--rules`: the built-in rules and those of
 * the plugins that load. Unlike {@link loadConfigFile}, it doesn't throw: plugins that fail to load
 * and errors in the config are returned as `problems`.
 */
export async function loadRuleRegistry(path: string | null): Promise<{ registry: RuleRegistry; problems: string[] }> {
  if (!path) return { registry: BUILTIN_RULES, problems: [] };
  const label = configLabel(path);
  let raw: unknown;
  let entries: PluginEntry[];
  try {
    raw = readConfigFile(path);
    entries = pluginEntries(raw, label);
  } catch (error) {
    return { registry: BUILTIN_RULES, problems: [(error as Error).message] };
  }
  const { plugins, errors } = await loadPluginsSettled(entries, dirname(path));
  const registry = plugins.size ? new RuleRegistry(plugins) : BUILTIN_RULES;
  const problems = errors.map((error) => `${label}: ${error.message.replace(/\.?$/, ".")} Its rules are not listed.`);
  // With a plugin missing, its rules in the config would only be reported as unknown.
  if (problems.length === 0) {
    try {
      parseConfig(raw, path, dirname(path), plugins);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
    }
  }
  return { registry, problems };
}

/** Looks for a config file in `startDir` and its ancestors. */
export function findConfigFile(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Matches a gitignore-style file pattern: patterns without a slash match the
 * file name at any depth, others match the path relative to the base dir.
 */
export function matchesFilePattern(pattern: string, base: string, absPath: string): boolean {
  const normalized = pattern.replace(/^\.\//, "");
  if (!normalized.includes("/")) {
    return new Glob(normalized).match(absPath.split(/[\\/]/).at(-1) as string);
  }
  const rel = toPosix(relative(base, absPath));
  if (rel.startsWith("..")) return false;
  return new Glob(normalized.replace(/^\//, "")).match(rel);
}

/** A rule-severity flag from the command line (`-A`, `-W`, `-D`). */
export interface CliRuleFlag {
  severity: Severity;
  /** Rule name, category name or `all`. */
  target: string;
}

export interface EnabledRule {
  /** Full rule name, e.g. `agentfile/no-missing-path`. */
  id: string;
  rule: AnyRule;
  severity: Exclude<Severity, "off">;
  options: unknown[];
}

interface Setting {
  severity: Severity;
  options: unknown[];
}

/** A rule setting as written in a config: a severity, followed by any options. */
const writtenSetting = ({ severity, options }: RuleSetting) => (options?.length ? [severity, ...options] : severity);

/** Computes the effective rule set for each file from built-in defaults, config and CLI flags. */
export class RuleResolver {
  readonly registry: RuleRegistry;
  private readonly base: Map<string, Setting>;
  private readonly cache = new Map<string, { settings: Map<string, Setting>; rules: EnabledRule[] }>();

  constructor(
    readonly config: Config,
    private readonly cliFlags: CliRuleFlag[] = [],
  ) {
    this.registry = config.registry;
    for (const flag of cliFlags) this.targetRules(flag.target, true);

    // 1. Built-in defaults: the rules in the "recommended" category are errors.
    const recommended = new Set(this.registry.inCategory("recommended"));
    this.base = new Map(
      [...this.registry.rules].map(([name, rule]) => [
        name,
        {
          severity: recommended.has(name) ? "error" : "off",
          // Frozen, as rules share their options across files.
          options: deepFreeze(rule.meta?.defaultOptions ?? []),
        },
      ]),
    );
    // 2. Config categories, 3. config rules.
    for (const [category, severity] of config.categories) {
      for (const name of this.registry.inCategory(category)) (this.base.get(name) as Setting).severity = severity;
    }
    for (const [name, setting] of config.rules) this.apply(this.base, name, setting);
  }

  private apply(settings: Map<string, Setting>, name: string, setting: RuleSetting) {
    const current = settings.get(name) as Setting;
    settings.set(name, {
      severity: setting.severity,
      options: setting.options ? deepFreeze(mergeOptions(current.options, setting.options)) : current.options,
    });
  }

  /** Resolves a CLI target to rule names; throws on unknown targets when `validate` is set. */
  private targetRules(target: string, validateOnly = false): string[] {
    if (target === "all") return [...this.registry.rules.keys()];
    if ((CATEGORIES as readonly string[]).includes(target)) return this.registry.inCategory(target as Category);
    const name = this.registry.resolve(target);
    if (!name) {
      throw new ConfigError(
        `Unknown rule or category "${target}".${suggestRule(this.registry, target)} (categories: ${CATEGORIES.join(", ")}, all)`,
      );
    }
    return validateOnly ? [] : [name];
  }

  private finalize(settings: Map<string, Setting>): EnabledRule[] {
    // 5. CLI flags, applied left to right.
    for (const flag of this.cliFlags) {
      for (const name of this.targetRules(flag.target)) (settings.get(name) as Setting).severity = flag.severity;
    }
    const enabled: EnabledRule[] = [];
    for (const [id, { severity, options }] of settings) {
      if (severity !== "off") enabled.push({ id, rule: this.registry.get(id) as AnyRule, severity, options });
    }
    return enabled;
  }

  private resolveForFile(absPath: string, root?: string) {
    const matching = this.config.overrides
      .map((override, index) => ({ override, index }))
      .filter(({ override }) =>
        override.files.some(
          (p) =>
            matchesFilePattern(p, this.config.dir, absPath) || (root && matchesFilePattern(p, this.config.dir, root)),
        ),
      );
    const key = matching.map((m) => m.index).join(",");
    let resolved = this.cache.get(key);
    if (!resolved) {
      const settings = new Map([...this.base].map(([k, v]) => [k, { ...v }]));
      // 4. Overrides in order.
      for (const { override } of matching) {
        for (const [name, setting] of override.rules) this.apply(settings, name, setting);
      }
      resolved = { settings, rules: this.finalize(settings) };
      this.cache.set(key, resolved);
    }
    return resolved;
  }

  /** Effective rules for a file (applies `overrides` matching it or, when given, `root`). */
  forFile(absPath: string, root?: string): EnabledRule[] {
    return this.resolveForFile(absPath, root).rules;
  }

  /** A rule's options at a path (with overrides matching it or `root`), even if the rule is off there. */
  optionsFor(id: string, absPath: string, root?: string): unknown[] {
    return (this.resolveForFile(absPath, root).settings.get(id) as Setting).options;
  }

  /** The base options and those of each override that sets options, which may select additional inputs. */
  discoveryOptions(id: string): unknown[][] {
    const base = (this.base.get(id) as Setting).options;
    const layers = this.config.overrides.flatMap(({ rules }) => {
      const options = rules.get(id)?.options;
      return options ? [deepFreeze(mergeOptions(base, options))] : [];
    });
    return [base, ...layers];
  }

  /** Whether a rule can be enabled at any path in this run. */
  canEnable(id: string): boolean {
    const flag = this.cliFlags.findLast(({ target }) => this.targetRules(target).includes(id));
    if (flag) return flag.severity !== "off";
    if (this.base.get(id)?.severity !== "off") return true;
    return this.config.overrides.some(({ rules }) => {
      const severity = rules.get(id)?.severity;
      return severity === "warn" || severity === "error";
    });
  }

  /** Effective rules for files not matched by any override. */
  baseRules(): EnabledRule[] {
    return this.finalize(new Map([...this.base].map(([k, v]) => [k, { ...v }])));
  }

  /** Effective configuration, for `--print-config`. */
  describe(): Record<string, unknown> {
    const enabled = new Map(this.baseRules().map((r) => [r.id, r]));
    return {
      jsPlugins: this.config.jsPlugins,
      files: this.config.files,
      rules: Object.fromEntries(
        [...this.registry.rules.keys()].map((id) => [id, writtenSetting(enabled.get(id) ?? { severity: "off" })]),
      ),
      overrides: this.config.overrides.map((o) => ({
        files: o.files,
        ...(o.jsPlugins.length ? { jsPlugins: o.jsPlugins } : {}),
        rules: Object.fromEntries([...o.rules].map(([name, s]) => [name, writtenSetting(s)])),
      })),
      ignorePatterns: this.config.ignorePatterns,
      settings: this.config.settings,
      reportUnnecessarySuppressions: this.config.reportUnnecessarySuppressions,
    };
  }
}
