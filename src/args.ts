import type { CliRuleFlag } from "./config.ts";
import { FORMATS, type Format } from "./formatters.ts";
import { CATEGORIES, CATEGORY_DESCRIPTIONS } from "./types.ts";

export interface CliArgs {
  paths: string[];
  config?: string;
  init: boolean;
  ruleFlags: CliRuleFlag[];
  ignorePath?: string;
  ignorePatterns: string[];
  noIgnore: boolean;
  quiet: boolean;
  denyWarnings: boolean;
  maxWarnings?: number;
  format: Format;
  silent: boolean;
  printConfig: boolean;
  /** `--debug` options (currently only `files`). */
  debug: DebugOption[];
  listRules: boolean;
  help: boolean;
  version: boolean;
}

export const DEBUG_OPTIONS = ["files"] as const;
export type DebugOption = (typeof DEBUG_OPTIONS)[number];

export class UsageError extends Error {
  override name = "UsageError";
}

type OptionSpec =
  | { takesValue: true; apply: (args: CliArgs, value: string) => void }
  | {
      takesValue: false;
      apply: (args: CliArgs) => void;
    };

const OPTIONS: Record<string, OptionSpec> = {
  "--config": { takesValue: true, apply: (a, v) => void (a.config = v) },
  "--init": { takesValue: false, apply: (a) => void (a.init = true) },
  "--allow": { takesValue: true, apply: (a, v) => void a.ruleFlags.push({ severity: "off", target: v }) },
  "--warn": { takesValue: true, apply: (a, v) => void a.ruleFlags.push({ severity: "warn", target: v }) },
  "--deny": { takesValue: true, apply: (a, v) => void a.ruleFlags.push({ severity: "error", target: v }) },
  "--ignore-path": { takesValue: true, apply: (a, v) => void (a.ignorePath = v) },
  "--ignore-pattern": { takesValue: true, apply: (a, v) => void a.ignorePatterns.push(v) },
  "--no-ignore": { takesValue: false, apply: (a) => void (a.noIgnore = true) },
  "--quiet": { takesValue: false, apply: (a) => void (a.quiet = true) },
  "--deny-warnings": { takesValue: false, apply: (a) => void (a.denyWarnings = true) },
  "--max-warnings": {
    takesValue: true,
    apply: (a, v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0)
        throw new UsageError(`--max-warnings expects a non-negative integer, got "${v}"`);
      a.maxWarnings = n;
    },
  },
  "--format": {
    takesValue: true,
    apply: (a, v) => {
      if (!(FORMATS as readonly string[]).includes(v)) {
        throw new UsageError(`Unknown format "${v}" (available: ${FORMATS.join(", ")})`);
      }
      a.format = v as Format;
    },
  },
  "--silent": { takesValue: false, apply: (a) => void (a.silent = true) },
  "--print-config": { takesValue: false, apply: (a) => void (a.printConfig = true) },
  "--debug": {
    takesValue: true,
    apply: (a, v) => {
      for (const option of v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)) {
        if (!(DEBUG_OPTIONS as readonly string[]).includes(option)) {
          throw new UsageError(`'${option}' is not a known debug option (available: ${DEBUG_OPTIONS.join(", ")})`);
        }
        if (!a.debug.includes(option as DebugOption)) a.debug.push(option as DebugOption);
      }
    },
  },
  "--rules": { takesValue: false, apply: (a) => void (a.listRules = true) },
  "--help": { takesValue: false, apply: (a) => void (a.help = true) },
  "--version": { takesValue: false, apply: (a) => void (a.version = true) },
};

const SHORT: Record<string, string> = {
  "-c": "--config",
  "-A": "--allow",
  "-W": "--warn",
  "-D": "--deny",
  "-f": "--format",
  "-h": "--help",
  "-V": "--version",
};

/** Parses argv (without the executable). Rule flags keep their command-line order. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    init: false,
    ruleFlags: [],
    ignorePatterns: [],
    noIgnore: false,
    quiet: false,
    denyWarnings: false,
    format: "default",
    silent: false,
    printConfig: false,
    debug: [],
    listRules: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      args.paths.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      args.paths.push(arg);
      continue;
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    } else if (!arg.startsWith("--") && arg.length > 2) {
      // -Dno-missing-path
      name = arg.slice(0, 2);
      inlineValue = arg.slice(2);
    }
    const long = SHORT[name] ?? name;
    const spec = OPTIONS[long];
    if (!spec) throw new UsageError(`Unknown option "${name}". Run "agentfile-linter --help" for usage.`);
    if (spec.takesValue) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new UsageError(`Option "${name}" requires a value`);
      spec.apply(args, value);
    } else {
      if (inlineValue !== undefined) throw new UsageError(`Option "${name}" does not take a value`);
      spec.apply(args);
    }
  }
  return args;
}

export const HELP = `Usage: agentfile-linter [OPTIONS] [PATH]...

Lints AI agent context files (AGENTS.md, CLAUDE.md, GEMINI.md, ...).
PATH defaults to the current directory.

Basic Configuration
  -c, --config=<./.agentfile-linterrc.json>
                          Configuration file (JSON with comments).
                          Defaults to the nearest .agentfile-linterrc.json(c).
      --init              Create a .agentfile-linterrc.json in the current directory

Allowing / Denying Multiple Lints
  Accumulated left to right on top of the config, e.g.
  \`-A all -D no-missing-path\` or \`-W recommended -A agentfile/no-missing-script\`.
  The categories (of built-in rules) are:
${CATEGORIES.map((category) => `    * ${category.padEnd(11)} - ${CATEGORY_DESCRIPTIONS[category]}`).join("\n")}
    * all         - Every rule, including those of plugins
  -A, --allow=NAME        Allow the rule or category (turn it off)
  -W, --warn=NAME         Report the rule or category as a warning
  -D, --deny=NAME         Report the rule or category as an error

Ignore Files
      --ignore-path=PATH  Ignore file to use (default: .agentfile-linterignore)
      --ignore-pattern=PAT
                          Additional gitignore-style pattern to ignore (repeatable)
      --no-ignore         Disable .gitignore, ignore files and ignore patterns

Handle Warnings
      --quiet             Only report errors
      --deny-warnings     Exit with a non-zero code when there are warnings
      --max-warnings=INT  Exit with a non-zero code when warnings exceed INT

Output
  -f, --format=ARG        Output format: ${FORMATS.join(", ")}

Miscellaneous
      --silent            Do not display any diagnostics
      --print-config      Print the effective configuration and exit
      --debug=OPTIONS     Enable debug output. Options are comma-separated:
                            * files - print the list of files that will be linted, then exit
      --rules             List all registered rules and exit
  -h, --help              Print help
  -V, --version           Print version

Inline Configuration Comments
  <!-- agentfile-linter-disable-next-line agentfile/no-missing-path -->
  <!-- agentfile-linter-disable-line -->
  <!-- agentfile-linter-disable agentfile/no-missing-script --> ... <!-- agentfile-linter-enable -->
  # agentfile-linter-disable-next-line agentfile/no-invalid-skill    (in YAML frontmatter)

Exit codes: 0 = no errors, 1 = lint errors (or warnings with --deny-warnings /
--max-warnings), 2 = invalid usage or configuration.
`;
