export type { CliRuleFlag, Config, EnabledRule } from "./config.ts";
export { ConfigError, DEFAULT_FILE_PATTERNS, findConfigFile, loadConfigFile, parseConfig } from "./config.ts";
export { type Format, FORMATS, format } from "./formatters.ts";
export { type LintOptions, lint, setup } from "./linter.ts";
export { RULES } from "#src/rules/index.ts";
export type * from "./types.ts";
