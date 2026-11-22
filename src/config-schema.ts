import { BUILTIN, BUILTIN_RULES } from "#src/rules/index.ts";

import { CATEGORIES, CATEGORY_DESCRIPTIONS } from "./types.ts";

const severity = {
  oneOf: [
    { type: "string", enum: ["off", "warn", "error", "allow", "deny"] },
    { type: "integer", enum: [0, 1, 2] },
  ],
};

/** A severity, optionally followed by options. */
const setting = (options?: unknown[], description?: string) => ({
  description,
  oneOf: [
    severity,
    {
      type: "array",
      prefixItems: [severity, ...(options ?? [])],
      minItems: 1,
      ...(options && { maxItems: 1 + options.length }),
    },
  ],
});

function rulesSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, { meta }] of BUILTIN_RULES.rules) {
    // Built-in rules have one schema per option.
    const options = setting(Array.isArray(meta?.schema) ? meta.schema : [], meta?.docs?.description);
    properties[name] = options;
    properties[name.slice(BUILTIN.length + 1)] = options;
  }
  return {
    type: "object",
    properties,
    // Rules of `jsPlugins`, named `plugin/rule`.
    patternProperties: { [`^(?!${BUILTIN}/).+/[^/]+$`]: setting() },
    additionalProperties: false,
  };
}

const jsPlugins = {
  type: "array",
  items: {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        required: ["name", "specifier"],
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Name of the plugin: the prefix of its rules." },
          specifier: { type: "string", description: "Path (relative to the config file) or package name." },
        },
      },
    ],
  },
  description:
    "ESLint or Oxlint plugins with custom rules, as in Oxlint: paths (relative to the config file) or package names. Use an object to name the plugin.",
};

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
      jsPlugins,
      files: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Gitignore-style patterns selecting the context files to lint. Defaults to AGENTS.md, AGENT.md, CLAUDE.md, CLAUDE.local.md and GEMINI.md in any directory.",
      },
      categories: {
        type: "object",
        description: "Severity for all built-in rules in a category.",
        properties: Object.fromEntries(
          CATEGORIES.map((category) => [category, { ...severity, description: CATEGORY_DESCRIPTIONS[category] }]),
        ),
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
            jsPlugins,
            rules,
          },
        },
      },
      ignorePatterns: {
        type: "array",
        items: { type: "string" },
        description: "Gitignore-style patterns of files that are not linted.",
      },
      settings: {
        type: "object",
        description: "Settings shared by all rules, which read them as `context.settings`.",
      },
      reportUnnecessarySuppressions: {
        type: "boolean",
        default: true,
        description: "Report inline suppression directives that suppress nothing, as info diagnostics.",
      },
    },
  };
}
