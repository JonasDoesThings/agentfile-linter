import { dirname, join, resolve } from "node:path";

import type { Project } from "#src/project.ts";
import { sliceToken, type Token } from "#src/shell.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, flagValue, hasFlag, notDefined, parseArgs } from "./util.ts";

const JUSTFILE_NAMES = ["justfile", ".justfile"];

interface Recipe {
  /** Number of required + optional parameters (variadic counts as one). */
  params: number;
}

export interface Justfile {
  file: string;
  recipes: Map<string, Recipe>;
  aliases: Map<string, string>;
  /** Module name -> module justfile (null when the file can't be found). */
  modules: Map<string, string | null>;
}

function findModuleFile(project: Project, dir: string, name: string, explicit?: string): string | null {
  if (explicit) {
    const abs = resolve(dir, explicit);
    return project.isDirectory(abs) ? project.findIn(abs, ["mod.just", ...JUSTFILE_NAMES], true) : abs;
  }
  return (
    project.findIn(dir, [`${name}.just`]) ??
    (project.isDirectory(join(dir, name))
      ? project.findIn(join(dir, name), ["mod.just", ...JUSTFILE_NAMES], true)
      : null)
  );
}

/** Parses recipes, aliases, imports and modules of a justfile. */
export function parseJustfile(project: Project, file: string, seen = new Set<string>()): Justfile {
  const result: Justfile = { file, recipes: new Map(), aliases: new Map(), modules: new Map() };
  if (seen.has(file)) return result;
  seen.add(file);
  const text = project.readText(file) ?? "";
  const dir = dirname(file);
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue; // recipe body
    const line = raw.replace(/^(?:\[[^\]]*\]\s*)+/, "").trimEnd(); // strip attributes like [private]
    if (!line || line.startsWith("#")) continue;
    let m: RegExpExecArray | null;
    if ((m = /^alias\s+([\w-]+)\s*:=\s*([\w:-]+)/.exec(line))) {
      result.aliases.set(m[1] as string, m[2] as string);
    } else if ((m = /^mod\??\s+([\w-]+)(?:\s+(['"])(.+?)\2)?/.exec(line))) {
      result.modules.set(m[1] as string, findModuleFile(project, dir, m[1] as string, m[3]));
    } else if ((m = /^import\??\s+(['"])(.+?)\1/.exec(line))) {
      const imported = parseJustfile(project, resolve(dir, m[2] as string), seen);
      for (const [k, v] of imported.recipes) result.recipes.set(k, v);
      for (const [k, v] of imported.aliases) result.aliases.set(k, v);
      for (const [k, v] of imported.modules) result.modules.set(k, v);
    } else if (/^(?:set|export|unexport)\s/.test(line) || /^[\w-]+\s*:=/.test(line)) {
      // settings and variables
    } else if ((m = /^@?([A-Za-z_][\w-]*)((?:\s+[^:]*?)?)\s*:(?!=)/.exec(line))) {
      const params = (m[2] as string).trim().split(/\s+/).filter(Boolean);
      result.recipes.set(m[1] as string, { params: params.length });
    }
  }
  return result;
}

function justfile(project: Project, file: string): Justfile {
  return project.memo(`just:${file}`, () => parseJustfile(project, file));
}

/** Flags after which no recipe is run (listing, formatting, …). */
const NON_RUN_FLAGS = [
  "-l",
  "--list",
  "--summary",
  "-e",
  "--edit",
  "--fmt",
  "--dump",
  "--evaluate",
  "--variables",
  "--init",
  "--completions",
  "--choose",
  "--man",
  "--changelog",
  "--groups",
  "-g",
  "--global-justfile",
  "-c",
  "--command",
  "--usage",
  "--help",
  "-h",
  "--version",
  "-V",
];

export const justRunner: TaskRunner = {
  id: "just",
  executables: ["just"],
  check(args: Token[], ctx: RunnerContext): Problem[] {
    const { project } = ctx;
    const parsed = parseArgs(args.slice(1), {
      valued: [
        "-f",
        "--justfile",
        "-d",
        "--working-directory",
        "--shell",
        "--shell-arg",
        "--dotenv-filename",
        "--dotenv-path",
        "-E",
        "--chooser",
        "--color",
        "--dump-format",
        "--list-heading",
        "--list-prefix",
        "--command-color",
        "--alias-style",
        "--timestamp-format",
        "--tempdir",
        "--completions",
      ],
    });
    if (hasFlag(parsed, ...NON_RUN_FLAGS)) return [];
    // `--set NAME VALUE` takes two values: drop the second one from the positionals.
    const positionals = parsed.positionals.filter((t, i, all) => {
      const prevFlag = parsed.flags.find((f) => f.name === "--set" && f.values[0] === all[i - 1]);
      return !prevFlag && !/^[A-Za-z_][\w-]*=/.test(t.value);
    });

    const explicit = flagValue(parsed, "-f", "--justfile");
    let file = explicit
      ? project.resolveExisting(ctx.cwd, explicit.value, "file")
      : project.findUp(ctx.cwd, JUSTFILE_NAMES, true);
    let first = positionals[0];
    // `just path/to/recipe` runs `recipe` from the justfile found in `path/to`.
    if (first?.value.includes("/") && !explicit) {
      const slash = first.value.lastIndexOf("/");
      file = project.findUp(project.resolveExisting(ctx.cwd, first.value.slice(0, slash), "dir"), JUSTFILE_NAMES, true);
      first = sliceToken(first, slash + 1);
    }
    if (!file || !project.isFile(file)) {
      return [{ token: first ?? (args[0] as Token), name: first?.value, message: "No justfile found" }];
    }
    if (!first) return []; // default recipe

    const problems: Problem[] = [];
    let current = justfile(project, file);
    const queue = [first, ...positionals.slice(1)];
    while (queue.length) {
      const token = queue.shift() as Token;
      const path = token.value.split("::");
      let name = path.pop() as string;
      // Descend into modules: `just mod recipe` or `just mod::recipe`.
      for (const mod of path) {
        const modFile = current.modules.get(mod);
        if (!modFile) return problems;
        current = justfile(project, modFile);
      }
      const modFile = current.modules.get(name);
      if (modFile !== undefined && path.length === 0) {
        if (!modFile) return problems;
        current = justfile(project, modFile);
        const next = queue[0];
        if (!next) return problems; // module default recipe
        continue;
      }
      name = current.aliases.get(name) ?? name;
      const recipe = current.recipes.get(name);
      if (!recipe) {
        problems.push(
          notDefined("Just recipe", token.value, token, `\`${display(project, current.file)}\``, [
            ...current.recipes.keys(),
            ...current.aliases.keys(),
          ]),
        );
        return problems;
      }
      // Further arguments are parameters unless the recipe takes none.
      if (recipe.params > 0) return problems;
    }
    return problems;
  },
};
