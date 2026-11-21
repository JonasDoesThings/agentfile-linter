import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { RULES, resolveRuleName, rulesInCategory, suggestRuleName } from "#src/rules/index.ts";

import { toPosix } from "./gitignore.ts";
import { validate } from "./schema.ts";
import { type AnyRule, CATEGORIES, type Category, type Severity } from "./types.ts";
import { isRecord } from "./util.ts";

export const CONFIG_FILE_NAMES = [".contextlintrc.json", ".contextlintrc.jsonc"];

/** Context files linted when the config doesn't specify `files`. */
export const DEFAULT_FILE_PATTERNS = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md"];

const TOP_LEVEL_KEYS = new Set(["$schema", "files", "categories", "rules", "overrides", "ignorePatterns"]);

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface RuleSetting {
  severity?: Severity;
  options?: Record<string, unknown>;
}

export interface Override {
  files: string[];
  rules: Map<string, RuleSetting>;
}

export interface Config {
  /** Absolute path of the config file, or null when running without one. */
  path: string | null;
  /** Base directory for `files`, `overrides[].files` and `ignorePatterns`. */
  dir: string;
  files: string[];
  categories: Map<Category, Severity>;
  rules: Map<string, RuleSetting>;
  overrides: Override[];
  ignorePatterns: string[];
}

export function emptyConfig(dir: string): Config {
  return {
    path: null,
    dir,
    files: DEFAULT_FILE_PATTERNS,
    categories: new Map(),
    rules: new Map(),
    overrides: [],
    ignorePatterns: [],
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

function suggestRule(name: string): string {
  const rule = suggestRuleName(name);
  return rule ? ` Did you mean "${rule}"?` : "";
}

function parseRuleSetting(name: string, value: unknown, where: string): [string, RuleSetting] {
  const ruleName = resolveRuleName(name);
  if (!ruleName) throw new ConfigError(`${where}: unknown rule "${name}".${suggestRule(name)}`);
  const rule = RULES.get(ruleName) as AnyRule;
  const [severityInput, options, ...rest] = Array.isArray(value) ? value : [value];
  const severity = normalizeSeverity(severityInput);
  if (!severity) {
    throw new ConfigError(
      `${where}: invalid severity ${JSON.stringify(severityInput)} for "${name}" (expected "off", "warn" or "error")`,
    );
  }
  if (rest.length) throw new ConfigError(`${where}: "${name}" accepts at most [severity, options]`);
  if (options === undefined) return [ruleName, { severity }];
  if (!rule.meta.schema) throw new ConfigError(`${where}: rule "${ruleName}" has no options`);
  const problems = validate(rule.meta.schema, options);
  if (problems.length) throw new ConfigError(`${where}: invalid options for "${ruleName}": ${problems.join("; ")}`);
  return [ruleName, { severity, options: options as Record<string, unknown> }];
}

function parseRules(value: unknown, where: string): Map<string, RuleSetting> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  return new Map(Object.entries(value).map(([name, setting]) => parseRuleSetting(name, setting, where)));
}

function parseStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return value;
}

/** Validates and normalizes a parsed config object. */
export function parseConfig(raw: unknown, path: string | null, dir: string): Config {
  const label = path ? relative(process.cwd(), path) || path : "config";
  if (!isRecord(raw)) throw new ConfigError(`${label}: config must be a JSON object`);
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
        if (key !== "files" && key !== "rules") throw new ConfigError(`${where}: unknown property "${key}"`);
      }
      const files = parseStringArray(entry.files, `${where}.files`);
      if (!files?.length) throw new ConfigError(`${where}.files must be a non-empty array of glob patterns`);
      overrides.push({ files, rules: parseRules(entry.rules, `${where}.rules`) });
    });
  }

  const files = parseStringArray(raw.files, `${label}: "files"`);
  if (files && files.length === 0) throw new ConfigError(`${label}: "files" must not be empty`);

  return {
    path,
    dir,
    files: files ?? DEFAULT_FILE_PATTERNS,
    categories,
    rules: parseRules(raw.rules, `${label}: "rules"`),
    overrides,
    ignorePatterns: parseStringArray(raw.ignorePatterns, `${label}: "ignorePatterns"`) ?? [],
  };
}

export function loadConfigFile(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = Bun.JSONC.parse(text);
  } catch (error) {
    throw new ConfigError(`Failed to parse ${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw, path, dirname(path));
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
    return new Bun.Glob(normalized).match(absPath.split(/[\\/]/).at(-1) as string);
  }
  const rel = toPosix(relative(base, absPath));
  if (rel.startsWith("..")) return false;
  return new Bun.Glob(normalized.replace(/^\//, "")).match(rel);
}

/** A rule-severity flag from the command line (`-A`, `-W`, `-D`). */
export interface CliRuleFlag {
  severity: Severity;
  /** Rule name, category name or `all`. */
  target: string;
}

export interface EnabledRule {
  rule: AnyRule;
  severity: Exclude<Severity, "off">;
  options: Record<string, unknown>;
}

interface Setting {
  severity: Severity;
  options: Record<string, unknown>;
}

/** Computes the effective rule set for each file from built-in defaults, config and CLI flags. */
export class RuleResolver {
  private readonly base: Map<string, Setting>;
  private readonly cache = new Map<string, { settings: Map<string, Setting>; rules: EnabledRule[] }>();

  constructor(
    readonly config: Config,
    private readonly cliFlags: CliRuleFlag[] = [],
  ) {
    for (const flag of cliFlags) this.targetRules(flag.target, true);

    // 1. Built-in defaults: rules in the "recommended" category at their default severity.
    this.base = new Map(
      [...RULES.values()].map((rule) => [
        rule.meta.name,
        {
          severity: rule.meta.categories.includes("recommended") ? rule.meta.defaultSeverity : "off",
          options: { ...rule.defaultOptions },
        },
      ]),
    );
    // 2. Config categories, 3. config rules.
    for (const [category, severity] of config.categories) {
      for (const rule of rulesInCategory(category)) (this.base.get(rule.meta.name) as Setting).severity = severity;
    }
    for (const [name, setting] of config.rules) this.apply(this.base, name, setting);
  }

  private apply(settings: Map<string, Setting>, name: string, setting: RuleSetting) {
    const current = settings.get(name) as Setting;
    settings.set(name, {
      severity: setting.severity ?? current.severity,
      options: setting.options ? { ...current.options, ...setting.options } : current.options,
    });
  }

  /** Resolves a CLI target to rule names; throws on unknown targets when `validate` is set. */
  private targetRules(target: string, validateOnly = false): string[] {
    if (target === "all") return [...RULES.keys()];
    if ((CATEGORIES as readonly string[]).includes(target)) {
      return rulesInCategory(target as Category).map((r) => r.meta.name);
    }
    const name = resolveRuleName(target);
    if (!name) {
      throw new ConfigError(
        `Unknown rule or category "${target}".${suggestRule(target)} (categories: ${CATEGORIES.join(", ")}, all)`,
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
    for (const [name, setting] of settings) {
      if (setting.severity === "off") continue;
      enabled.push({ rule: RULES.get(name) as AnyRule, severity: setting.severity, options: setting.options });
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
  optionsFor(rule: AnyRule, absPath: string, root?: string): Record<string, unknown> {
    return this.resolveForFile(absPath, root).settings.get(rule.meta.name)?.options ?? rule.defaultOptions;
  }

  /** Option layers that may introduce additional inputs. */
  discoveryOptions(rule: AnyRule): Record<string, unknown>[] {
    const name = rule.meta.name;
    const layers = [this.base.get(name)?.options ?? rule.defaultOptions];
    for (const override of this.config.overrides) {
      const options = override.rules.get(name)?.options;
      if (options) layers.push(options);
    }
    return layers;
  }

  /** Whether a rule can be enabled at any path in this run. */
  canEnable(rule: AnyRule): boolean {
    const name = rule.meta.name;
    const flag = this.cliFlags.findLast(({ target }) => this.targetRules(target).includes(name));
    if (flag) return flag.severity !== "off";
    if (this.base.get(name)?.severity !== "off") return true;
    return this.config.overrides.some(({ rules }) => {
      const severity = rules.get(name)?.severity;
      return severity === "warn" || severity === "error";
    });
  }

  /** Effective rules for files not matched by any override. */
  baseRules(): EnabledRule[] {
    return this.finalize(new Map([...this.base].map(([k, v]) => [k, { ...v }])));
  }

  /** Effective configuration, for `--print-config`. */
  describe(): Record<string, unknown> {
    const rules: Record<string, unknown> = {};
    const enabled = new Map(this.baseRules().map((r) => [r.rule.meta.name, r]));
    for (const name of RULES.keys()) {
      const rule = enabled.get(name);
      rules[name] = rule ? [rule.severity, rule.options] : "off";
    }
    return {
      files: this.config.files,
      rules,
      overrides: this.config.overrides.map((o) => ({
        files: o.files,
        rules: Object.fromEntries(
          [...o.rules].map(([name, s]) => [name, s.options ? [s.severity, s.options] : s.severity]),
        ),
      })),
      ignorePatterns: this.config.ignorePatterns,
    };
  }
}
