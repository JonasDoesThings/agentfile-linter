import { closest } from "#src/text.ts";
import type { AnyRule, Category } from "#src/types.ts";

import { keepAgentsFileUpToDate } from "./keep-agents-file-up-to-date.ts";
import { limitFileSize } from "./limit-file-size.ts";
import { noAgentFilesDrift } from "./no-agent-files-drift.ts";
import { noBrokenReference } from "./no-broken-reference.ts";
import { noInvalidSkill } from "./no-invalid-skill.ts";
import { noMisnamedAgentFile } from "./no-misnamed-agent-file.ts";
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
    noMisnamedAgentFile,
    noUnnecessaryAgentFiles,
    keepAgentsFileUpToDate,
    limitFileSize,
  ].map((rule) => [rule.meta.name, rule]),
);

export const RULE_PREFIX = "agentfile/";

/** Resolves `no-missing-path` or `agentfile/no-missing-path` to the canonical rule name. */
export function resolveRuleName(name: string): string | undefined {
  if (RULES.has(name)) return name;
  const prefixed = `${RULE_PREFIX}${name}`;
  return RULES.has(prefixed) ? prefixed : undefined;
}

/** The rule whose name is closest to `name` (with or without a prefix), for "did you mean" hints. */
export function suggestRuleName(name: string): string | undefined {
  const bare = name.replace(/^.*\//, "");
  const match = closest(
    bare,
    [...RULES.keys()].map((rule) => rule.slice(RULE_PREFIX.length)),
  );
  return match === undefined ? undefined : `${RULE_PREFIX}${match}`;
}

export function rulesInCategory(category: Category): AnyRule[] {
  return [...RULES.values()].filter((rule) => rule.meta.categories.includes(category));
}
