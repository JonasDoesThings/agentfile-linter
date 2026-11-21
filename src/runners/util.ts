import { relative } from "node:path";

import type { Project } from "#src/project.ts";
import { sliceToken, type Token } from "#src/shell.ts";
import { closest, list } from "#src/text.ts";

import type { Problem } from "./types.ts";

/** Project-relative display path. */
export function display(project: Project, abs: string): string {
  return relative(project.root, abs) || ".";
}

/** `./gradlew` -> `gradlew`, `mvnw.cmd` -> `mvnw`. */
export function executableName(value: string): string {
  return (value.split(/[\\/]/).at(-1) ?? value).replace(/\.(?:exe|cmd|bat|phar)$/i, "");
}

/** Standard "X `name` is not defined in `file`" problem with a suggestion or the available names. */
export function notDefined(
  kind: string,
  name: string,
  token: Token,
  where: string,
  available: Iterable<string>,
): Problem {
  const names = [...new Set(available)].filter((n) => !n.startsWith("_") && !n.startsWith("."));
  const suggestion = closest(name, names);
  return {
    token,
    name,
    message: `${kind} \`${name}\` is not defined in ${where}`,
    help: suggestion
      ? `Did you mean \`${suggestion}\`?`
      : names.length
        ? `Available: ${list(names.toSorted())}`
        : undefined,
  };
}

export interface ArgSpec {
  /** Flags taking a value: `-C dir`, `-Cdir` (two-letter flags), `--dir dir`, `--dir=dir`. */
  valued?: readonly string[];
  /** Flags whose value is only consumed when it matches `optionalValue` (e.g. `make -j 4`). */
  optional?: readonly string[];
  optionalValue?: RegExp;
  /** Flags consuming all following non-flag tokens (e.g. `nox -s a b`). */
  multi?: readonly string[];
  /** Flags without value that would otherwise look like an attached value (`mvn -fae` vs `-f <file>`). */
  boolean?: readonly string[];
  /** Treat everything after the first positional as positional (subcommand arguments). */
  stopAtPositional?: boolean;
}

export interface ParsedFlag {
  name: string;
  values: Token[];
  token: Token;
}

export interface ParsedArgs {
  flags: ParsedFlag[];
  positionals: Token[];
}

/** Generic GNU-style argument parser. `tokens` must not include the executable. */
export function parseArgs(tokens: Token[], spec: ArgSpec = {}): ParsedArgs {
  const valued = new Set(spec.valued ?? []);
  const optional = new Set(spec.optional ?? []);
  const multi = new Set(spec.multi ?? []);
  const boolean = new Set(spec.boolean ?? []);
  const flags: ParsedFlag[] = [];
  const positionals: Token[] = [];
  let stopped = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    const v = token.value;
    if (v === "--") break;
    if (stopped || !v.startsWith("-") || v === "-") {
      positionals.push(token);
      if (spec.stopAtPositional) stopped = true;
      continue;
    }
    const eq = v.indexOf("=");
    if (boolean.has(v)) {
      flags.push({ name: v, values: [], token });
    } else if (v.startsWith("--") && eq > 0) {
      flags.push({ name: v.slice(0, eq), values: [sliceToken(token, eq + 1)], token });
    } else if (valued.has(v)) {
      const next = tokens[i + 1];
      flags.push({ name: v, values: next ? [next] : [], token });
      if (next) i++;
    } else if (multi.has(v)) {
      const values: Token[] = [];
      while (tokens[i + 1] && !(tokens[i + 1] as Token).value.startsWith("-")) values.push(tokens[++i] as Token);
      flags.push({ name: v, values, token });
    } else if (optional.has(v)) {
      const next = tokens[i + 1];
      const take = next && spec.optionalValue?.test(next.value);
      flags.push({ name: v, values: take ? [next] : [], token });
      if (take) i++;
    } else if (!v.startsWith("--") && v.length > 2 && valued.has(v.slice(0, 2))) {
      flags.push({ name: v.slice(0, 2), values: [sliceToken(token, 2)], token });
    } else {
      flags.push({ name: v, values: [], token });
    }
  }
  return { flags, positionals };
}

/** The last value of any of the given flags. */
export function flagValue(parsed: ParsedArgs, ...names: string[]): Token | undefined {
  let found: Token | undefined;
  for (const flag of parsed.flags) if (names.includes(flag.name) && flag.values.length) found = flag.values.at(-1);
  return found;
}

/** All values of the given flags, split on commas. */
export function flagValues(parsed: ParsedArgs, ...names: string[]): Token[] {
  const out: Token[] = [];
  for (const flag of parsed.flags) {
    if (!names.includes(flag.name)) continue;
    for (const value of flag.values) {
      let start = 0;
      for (const part of value.value.split(",")) {
        if (part) out.push(sliceToken(value, start, start + part.length));
        start += part.length + 1;
      }
    }
  }
  return out;
}

export function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return parsed.flags.some((f) => names.includes(f.name));
}
