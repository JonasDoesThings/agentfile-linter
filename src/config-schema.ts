import { RULES } from "#src/rules/index.ts";

import { toJsonSchema } from "./schema.ts";
import { CATEGORIES } from "./types.ts";

const severity = {
  oneOf: [
    { type: "string", enum: ["off", "warn", "error", "allow", "deny"] },
    { type: "integer", enum: [0, 1, 2] },
  ],
};

function rulesSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const rule of RULES.values()) {
    const options = rule.meta.schema ? toJsonSchema(rule.meta.schema) : undefined;
    const setting = {
      description: rule.meta.description,
      oneOf: [
        severity,
        {
          type: "array",
          prefixItems: options ? [severity, options] : [severity],
          minItems: 1,
          maxItems: options ? 2 : 1,
        },
      ],
    };
    properties[rule.meta.name] = setting;
    properties[rule.meta.name.replace(/^agentfile\//, "")] = setting;
  }
  return { type: "object", properties, additionalProperties: false };
}

/** JSON schema for .agentfile-linterrc.json, generated from the rule registry. */
export function buildConfigSchema(): Record<string, unknown> {
  const rules = rulesSchema();
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "agentfile-linter configuration",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      files: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Gitignore-style patterns selecting the context files to lint. Defaults to AGENTS.md, AGENT.md, CLAUDE.md, CLAUDE.local.md and GEMINI.md in any directory.",
      },
      categories: {
        type: "object",
        description: "Severity for all rules in a category.",
        properties: Object.fromEntries(CATEGORIES.map((c) => [c, severity])),
        additionalProperties: false,
      },
      rules,
      overrides: {
        type: "array",
        items: {
          type: "object",
          required: ["files"],
          additionalProperties: false,
          properties: {
            files: { type: "array", items: { type: "string" }, minItems: 1 },
            rules,
          },
        },
      },
      ignorePatterns: {
        type: "array",
        items: { type: "string" },
        description: "Gitignore-style patterns of files that are not linted.",
      },
    },
  };
}
