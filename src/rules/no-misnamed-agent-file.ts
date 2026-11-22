import { basename, dirname, join } from "node:path";

import type { Project } from "#src/project.ts";
import { DEFAULT_FILE_PATTERNS, type Rule, type TreeDiscoveryContext } from "#src/types.ts";

const CLAUDE_FILE = "CLAUDE.md";

/**
 * Correct context file names by their lowercase spelling. A misnamed `SKILL.md` is reported by
 * `agentfile/no-invalid-skill`, which knows where skills are loaded from.
 */
const NAMES = new Map(DEFAULT_FILE_PATTERNS.map((name) => [name.toLowerCase(), name]));

/** Files that mark the root of a package, where the package's own context files live. */
const PACKAGE_MANIFESTS = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
];

/** The name a file is a differently cased spelling of (`agents.md` → `AGENTS.md`), if any. */
function intendedName(name: string): string | undefined {
  const correct = NAMES.get(name.toLowerCase());
  return correct === name ? undefined : correct;
}

const stem = (name: string) => name.slice(0, -".md".length);

/** A Markdown page with a lowercase letter in its name, like the pages of a documentation folder. */
function isPage(name: string): boolean {
  const match = /^(.+)\.(?:md|mdx|markdown)$/i.exec(name);
  return match !== null && !NAMES.has(name.toLowerCase()) && /\p{Ll}/u.test(match[1] ?? "");
}

/**
 * Whether a misnamed file is obviously meant to be `expected`. `claude.md` or `agents.md` is also
 * a common name for a documentation page or a prompt, so such names only count where context files
 * are expected.
 */
function isMeantAs(project: Project, path: string, expected: string, entries: readonly string[]): boolean {
  // Only the extension differs (`AGENTS.MD`).
  if (stem(basename(path)) === stem(expected)) return true;
  if (entries.some(isPage)) return false;
  const dir = dirname(path);
  // Relative to the project root, so that the name of the checkout directory doesn't matter.
  const rel = project.relative(dir);
  return (
    rel === "" ||
    (expected === CLAUDE_FILE && basename(rel) === ".claude") ||
    entries.some((entry) => DEFAULT_FILE_PATTERNS.includes(entry) && project.isFile(join(dir, entry))) ||
    PACKAGE_MANIFESTS.some((manifest) => entries.includes(manifest))
  );
}

/** The name a file should have, when it is a misnamed context file. */
function misnamedAs(ctx: Pick<TreeDiscoveryContext<unknown[]>, "projectFor" | "isContextFile">, path: string) {
  const expected = intendedName(basename(path));
  // Configured `files` patterns make the name a context file.
  if (!expected || ctx.isContextFile(path)) return undefined;
  const dir = dirname(path);
  const project = ctx.projectFor(dir);
  // Directory entries keep their case; a stat of `AGENTS.md` would also find `agents.md` on
  // case-insensitive file systems.
  const entries = project.readDir(dir) ?? [];
  // With the correct name taken too, the file is something else.
  if (entries.includes(expected) || !project.isFile(path)) return undefined;
  return isMeantAs(project, path, expected, entries) ? expected : undefined;
}

export const noMisnamedAgentFile: Rule = {
  meta: {
    docs: {
      description: "AGENTS.md, CLAUDE.md, ... must be named in the exact case agents look for",
      recommended: true,
      category: "correctness",
    },
  },
  collectTreeInputs(ctx) {
    // Files named on the command line are linted as context files; `checkTree` checks their names.
    const explicitFiles = new Set(ctx.explicitFiles);
    const inputs: { path: string }[] = [];
    for (const dir of ctx.directories) {
      // Like discovery, look into symlinked directories only when they are named as inputs.
      if (!ctx.directoryInputs.includes(dir) && ctx.projectFor(dirname(dir)).isSymlink(dir)) continue;
      for (const name of ctx.projectFor(dir).readDir(dir) ?? []) {
        const path = join(dir, name);
        if (!intendedName(name) || explicitFiles.has(path) || ctx.isIgnored(path, false)) continue;
        if (misnamedAs(ctx, path)) inputs.push({ path });
      }
    }
    return inputs;
  },
  checkTree(ctx) {
    // Every context file has its name checked; correctly named ones pass.
    for (const path of ctx.contextFiles) ctx.markChecked(path);
    const paths = [...ctx.treeInputs.map(({ path }) => path), ...ctx.explicitFiles];
    for (const path of paths.toSorted()) {
      const expected = misnamedAs(ctx, path);
      if (!expected) continue;
      ctx.report(path, {
        message: `\`${basename(path)}\` must be named exactly \`${expected}\``,
        help:
          `Agents look for \`${expected}\`; other spellings are not found on case-sensitive file systems. ` +
          "If Git tracks the file, rename it with `git mv`: on case-insensitive file systems (the macOS and " +
          "Windows default), Git doesn't notice a plain rename that only changes case.",
      });
    }
  },
};
