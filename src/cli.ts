#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import pkg from "#package.json" with { type: "json" };
import { RULES } from "#src/rules/index.ts";

import { HELP, parseArgs, UsageError } from "./args.ts";
import { shouldUseColor } from "./colors.ts";
import { CONFIG_FILE_NAMES, ConfigError } from "./config.ts";
import { format } from "./formatters.ts";
import { collectFiles, lint, setup } from "./linter.ts";

const INIT_CONFIG = `{
  // Severity for every rule in a category: "off" | "warn" | "error"
  "categories": {
    "recommended": "error"
  },
  // Per-rule overrides, e.g. "context/no-missing-script": "warn"
  // or with options: "context/no-missing-path": ["error", { "ignore": ["generated/**"] }]
  "rules": {},
  // gitignore-style patterns of files that should not be linted
  "ignorePatterns": []
}
`;

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

function listRules(): string {
  const rows = [...RULES.values()].map((r) => [
    r.meta.name,
    r.meta.categories.join(", "),
    r.meta.defaultSeverity,
    r.meta.description,
  ]);
  const header = ["Rule", "Category", "Default", "Description"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i] as number)))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `Total: ${rows.length} rules`,
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(HELP);
      return 0;
    }
    if (args.version) {
      out(`contextlint ${pkg.version}\n`);
      return 0;
    }
    if (args.listRules) {
      out(`${listRules()}\n`);
      return 0;
    }
    if (args.init) {
      const cwd = process.cwd();
      const existing = CONFIG_FILE_NAMES.find((name) => existsSync(join(cwd, name)));
      if (existing) {
        err(`${existing} already exists.\n`);
        return 2;
      }
      const name = CONFIG_FILE_NAMES[0] as string;
      try {
        writeFileSync(join(cwd, name), INIT_CONFIG, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        err(`${name} already exists.\n`);
        return 2;
      }
      out(`Created ${name}.\n`);
      return 0;
    }

    const options = {
      paths: args.paths,
      config: args.config,
      ruleFlags: args.ruleFlags,
      ignorePatterns: args.ignorePatterns,
      ignorePath: args.ignorePath,
      noIgnore: args.noIgnore,
    };
    const prepared = setup(options);
    if (args.printConfig) {
      const description = {
        configFile: prepared.config.path ? relative(prepared.cwd, prepared.config.path) || prepared.config.path : null,
        ...prepared.resolver.describe(),
      };
      out(`${JSON.stringify(description, null, 2)}\n`);
      return 0;
    }

    if (args.debug.includes("files")) {
      for (const file of collectFiles(options, prepared)) out(`${relative(prepared.cwd, file) || file}\n`);
      return 0;
    }

    const result = await lint(options, prepared);
    const warningCount = result.warningCount;
    if (args.quiet) {
      for (const file of result.files) file.diagnostics = file.diagnostics.filter((d) => d.severity === "error");
      result.warningCount = 0;
    }
    if (!args.silent) {
      out(format(result, args.format, { cwd: prepared.cwd, color: shouldUseColor(process.stdout) }));
      if (result.fileCount === 0 && result.errorCount === 0 && warningCount === 0 && args.format === "default") {
        err(`No context files found (looking for: ${prepared.config.files.join(", ")}).\n`);
      }
    }

    if (result.errorCount > 0) return 1;
    if (args.denyWarnings && warningCount > 0) return 1;
    if (args.maxWarnings !== undefined && warningCount > args.maxWarnings) {
      if (!args.silent) err(`Too many warnings (${warningCount}, maximum allowed is ${args.maxWarnings}).\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      err(`contextlint: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}

if (import.meta.main) {
  // No top-level await: `bun build --compile --bytecode` emits CommonJS.
  void run();
}
