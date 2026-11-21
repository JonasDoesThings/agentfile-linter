import { dirname } from "node:path";

import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";
import { asRecord } from "#src/util.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, flagValue, hasFlag, notDefined, parseArgs } from "./util.ts";

const DENO_CONFIGS = ["deno.json", "deno.jsonc"];

function denoTasks(project: Project, file: string): string[] {
  return Object.keys(asRecord(asRecord(project.readJson(file)).tasks));
}

/** `deno task <name>`: tasks from deno.json(c), plus package.json scripts. */
export const denoRunner: TaskRunner = {
  id: "deno",
  executables: ["deno"],
  check(args: Token[], ctx: RunnerContext): Problem[] {
    const { project } = ctx;
    if (args[1]?.value !== "task") return [];
    const parsed = parseArgs(args.slice(2), {
      valued: ["-c", "--config", "--cwd", "-f", "--filter"],
      stopAtPositional: true,
    });
    const name = parsed.positionals[0];
    if (!name || hasFlag(parsed, "--eval")) return [];

    // Workspace runs: the task must exist in some member.
    if (hasFlag(parsed, "-r", "--recursive", "-f", "--filter")) {
      const all = project.findFilesNamed(DENO_CONFIGS).flatMap((f) => denoTasks(project, f));
      const scripts = project.workspaces.allPackages().flatMap((p) => Object.keys(p.scripts));
      return all.includes(name.value) || scripts.includes(name.value)
        ? []
        : [notDefined("Deno task", name.value, name, "any workspace member", all)];
    }

    const cwdFlag = flagValue(parsed, "--cwd");
    const dir = cwdFlag ? project.resolveExisting(ctx.cwd, cwdFlag.value, "dir") : ctx.cwd;
    const configFlag = flagValue(parsed, "-c", "--config");
    const config = configFlag
      ? project.resolveExisting(ctx.cwd, configFlag.value, "file")
      : project.findUp(dir, DENO_CONFIGS);
    const tasks = config ? denoTasks(project, config) : [];
    // deno task also runs package.json scripts.
    const pkg = project.workspaces.nearestPackage(config ? dirname(config) : dir);
    const scripts = pkg ? Object.keys(pkg.scripts) : [];
    if (tasks.includes(name.value) || scripts.includes(name.value)) return [];
    if (!config && !pkg)
      return [{ token: name, name: name.value, message: `No deno.json found for \`${name.value}\`` }];
    const where = config ? `\`${display(project, config)}\`` : `\`${display(project, `${pkg?.dir}/package.json`)}\``;
    return [notDefined("Deno task", name.value, name, where, [...tasks, ...scripts])];
  },
};
