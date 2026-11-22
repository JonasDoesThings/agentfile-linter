import { closest } from "#src/text.ts";
import type { AnyRule, Category, Plugin, RuleCategory } from "#src/types.ts";

import { keepAgentsFileUpToDate } from "./keep-agents-file-up-to-date.ts";
import { limitFileSize } from "./limit-file-size.ts";
import { noAgentFilesDrift } from "./no-agent-files-drift.ts";
import { noBrokenReference } from "./no-broken-reference.ts";
import { noClaudeLocalInGit } from "./no-claude-local-in-git.ts";
import { noInvalidSkill } from "./no-invalid-skill.ts";
import { noMisnamedAgentFile } from "./no-misnamed-agent-file.ts";
import { noMissingPath } from "./no-missing-path.ts";
import { noMissingScript } from "./no-missing-script.ts";
import { noUnnecessaryAgentFiles } from "./no-unnecessary-agent-files.ts";

/** The name of the plugin that holds the built-in rules. Built-in rules can be named without it. */
export const BUILTIN = "agentfile";

/** The built-in rules, as a plugin. */
export const BUILTIN_PLUGIN = {
  meta: { name: BUILTIN },
  rules: {
    "no-missing-path": noMissingPath,
    "no-missing-script": noMissingScript,
    "no-broken-reference": noBrokenReference,
    "no-agent-files-drift": noAgentFilesDrift,
    "no-invalid-skill": noInvalidSkill,
    "no-misnamed-agent-file": noMisnamedAgentFile,
    "no-claude-local-in-git": noClaudeLocalInGit,
    "no-unnecessary-agent-files": noUnnecessaryAgentFiles,
    "keep-agents-file-up-to-date": keepAgentsFileUpToDate,
    "limit-file-size": limitFileSize,
  },
} satisfies Plugin;

/** The rules of a run by full name (`plugin/rule`): the built-in rules and those of the loaded plugins. */
export class RuleRegistry {
  readonly rules: ReadonlyMap<string, AnyRule>;

  /** `plugins`: loaded plugins by name. */
  constructor(plugins: ReadonlyMap<string, Plugin> = new Map()) {
    const rules = new Map<string, AnyRule>();
    for (const [name, plugin] of [[BUILTIN, BUILTIN_PLUGIN] as const, ...plugins]) {
      for (const [rule, implementation] of Object.entries(plugin.rules ?? {}))
        rules.set(`${name}/${rule}`, implementation);
    }
    this.rules = rules;
  }

  get(name: string): AnyRule | undefined {
    return this.rules.get(name);
  }

  /** Resolves `no-missing-path` or `agentfile/no-missing-path` to the rule's full name. */
  resolve(name: string): string | undefined {
    if (this.rules.has(name)) return name;
    const builtin = `${BUILTIN}/${name}`;
    return this.rules.has(builtin) ? builtin : undefined;
  }

  /** The rule of the same plugin whose name is closest to `name`, for "did you mean" hints. */
  suggest(name: string): string | undefined {
    const slash = name.lastIndexOf("/");
    const plugin = slash === -1 ? BUILTIN : name.slice(0, slash);
    const prefix = `${plugin}/`;
    const names = [...this.rules.keys()].filter((rule) => rule.startsWith(prefix));
    const match = closest(
      name.slice(slash + 1),
      names.map((rule) => rule.slice(prefix.length)),
    );
    return match === undefined ? undefined : `${prefix}${match}`;
  }

  /** The category of a built-in rule. Plugin rules have none, as in Oxlint. */
  categoryOf(name: string): RuleCategory | undefined {
    return name.startsWith(`${BUILTIN}/`) ? this.rules.get(name)?.meta?.docs?.category : undefined;
  }

  /** Whether a rule is on by default: a built-in rule with `docs.recommended`. */
  isRecommended(name: string): boolean {
    return name.startsWith(`${BUILTIN}/`) && this.rules.get(name)?.meta?.docs?.recommended === true;
  }

  /** The rules in `category`: a rule category, or `recommended`. */
  inCategory(category: Category): string[] {
    const matches = (name: string) =>
      category === "recommended" ? this.isRecommended(name) : this.categoryOf(name) === category;
    return [...this.rules.keys()].filter(matches);
  }
}

/** The built-in rules alone, for runs without plugins. */
export const BUILTIN_RULES = new RuleRegistry();
