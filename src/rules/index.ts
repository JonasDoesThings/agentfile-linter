import type { AnyRule, Category } from "#src/types.ts";

import { keepAgentsFileUpToDate } from "./keep-agents-file-up-to-date.ts";
import { noAgentFilesDrift } from "./no-agent-files-drift.ts";
import { noBrokenReference } from "./no-broken-reference.ts";
import { noInvalidSkill } from "./no-invalid-skill.ts";
import { noMissingPath } from "./no-missing-path.ts";
import { noMissingScript } from "./no-missing-script.ts";
import { noUnnecessaryAgentFiles } from "./no-unnecessary-agent-files.ts";

/** All built-in rules, keyed by their fully qualified name. */
export const RULES: ReadonlyMap<string, AnyRule> = new Map(
  [
    noMissingPath,
    noMissingScript,
    noBrokenReference,
    noAgentFilesDrift,
    noInvalidSkill,
    noUnnecessaryAgentFiles,
    keepAgentsFileUpToDate,
  ].map((rule) => [rule.meta.name, rule]),
);

export const RULE_PREFIX = "context/";

/** Resolves `no-missing-path` or `context/no-missing-path` to the canonical rule name. */
export function resolveRuleName(name: string): string | undefined {
  if (RULES.has(name)) return name;
  const prefixed = `${RULE_PREFIX}${name}`;
  return RULES.has(prefixed) ? prefixed : undefined;
}

export function rulesInCategory(category: Category): AnyRule[] {
  return [...RULES.values()].filter((rule) => rule.meta.categories.includes(category));
}
