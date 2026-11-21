import { dirname, resolve } from "node:path";

import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";
import { asRecord } from "#src/util.ts";

import { pyprojectFor } from "./python.ts";
import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, flagValue, hasFlag, notDefined, parseArgs } from "./util.ts";

export const TASKFILE_NAMES = [
  "Taskfile.yml",
  "taskfile.yml",
  "Taskfile.yaml",
  "taskfile.yaml",
  "Taskfile.dist.yml",
  "taskfile.dist.yml",
  "Taskfile.dist.yaml",
  "taskfile.dist.yaml",
];

export interface Taskfile {
  tasks: Set<string>;
  /** Includes with templated paths: unknown tasks can't be ruled out. */
  dynamic: boolean;
}

/** Parses a go-task Taskfile, including (namespaced) includes. */
export function parseTaskfile(project: Project, file: string, seen = new Set<string>()): Taskfile {
  const result: Taskfile = { tasks: new Set(), dynamic: false };
  if (seen.has(file)) return result;
  let doc: Record<string, unknown>;
  try {
    doc = asRecord(Bun.YAML.parse(project.readText(file) ?? ""));
  } catch {
    result.dynamic = true;
    return result;
  }
  for (const [name, spec] of Object.entries(asRecord(doc.tasks))) {
    result.tasks.add(name);
    const aliases = asRecord(spec).aliases;
    if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === "string") result.tasks.add(alias);
  }
  const ancestors = new Set(seen).add(file);
  for (const [namespace, spec] of Object.entries(asRecord(doc.includes))) {
    const entry = typeof spec === "string" ? { taskfile: spec } : asRecord(spec);
    const path = entry.taskfile;
    if (typeof path !== "string" || path.includes("{{")) {
      result.dynamic = true;
      continue;
    }
    let target = resolve(dirname(file), path);
    if (project.isDirectory(target)) target = project.findIn(target, TASKFILE_NAMES) ?? target;
    if (!project.isFile(target)) continue;
    const included = parseTaskfile(project, target, ancestors);
    const prefixes =
      entry.flatten === true ? [""] : [namespace, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const prefix of prefixes) {
      for (const task of included.tasks) result.tasks.add(prefix ? `${prefix}:${task}` : task);
    }
    result.dynamic ||= included.dynamic;
  }
  return result;
}

const NON_RUN_FLAGS = [
  "-l",
  "--list",
  "-a",
  "--list-all",
  "-i",
  "--init",
  "--completion",
  "-g",
  "--global",
  "--version",
  "-h",
  "--help",
  "--experiments",
];

/** go-task (`task build`), falling back to taskipy (`[tool.taskipy.tasks]`) when there's no Taskfile. */
export const taskRunner: TaskRunner = {
  id: "task",
  executables: ["task", "go-task"],
  check(args: Token[], ctx: RunnerContext): Problem[] {
    const { project } = ctx;
    const parsed = parseArgs(args.slice(1), {
      valued: [
        "-d",
        "--dir",
        "-t",
        "--taskfile",
        "-o",
        "--output",
        "--output-group-begin",
        "--output-group-end",
        "-C",
        "--concurrency",
        "-I",
        "--interval",
        "--sort",
        "--completion",
      ],
    });
    if (hasFlag(parsed, ...NON_RUN_FLAGS)) return [];
    const names = parsed.positionals.filter((t) => !/^[A-Za-z_]\w*=/.test(t.value));
    if (!names.length) return [];

    const dirFlag = flagValue(parsed, "-d", "--dir");
    const dir = dirFlag ? project.resolveExisting(ctx.cwd, dirFlag.value, "dir") : ctx.cwd;
    const fileFlag = flagValue(parsed, "-t", "--taskfile");
    let file: string | null = null;
    if (fileFlag) {
      const abs = resolve(dir, fileFlag.value);
      file = project.isDirectory(abs) ? project.findIn(abs, TASKFILE_NAMES) : abs;
    } else {
      file = project.findUp(dir, TASKFILE_NAMES);
    }

    if (!file || !project.isFile(file)) {
      // taskipy uses the same `task` command with tasks in pyproject.toml.
      const py = pyprojectFor(project, dir);
      const taskipy = asRecord(asRecord(py?.data.tool).taskipy).tasks;
      if (py && taskipy !== undefined) {
        const tasks = Object.keys(asRecord(taskipy));
        const first = names[0] as Token;
        return tasks.includes(first.value)
          ? []
          : [notDefined("Taskipy task", first.value, first, `\`${display(project, py.file)}\``, tasks)];
      }
      // `task` is a generic word: only complain when the project uses go-task somewhere.
      if (!project.findFilesNamed(TASKFILE_NAMES).length) return [];
      return [{ token: names[0] as Token, name: names[0]?.value, message: "No Taskfile found" }];
    }

    const taskfile = project.memo(`task:${file}`, () => {
      const { tasks: declaredTasks, dynamic } = parseTaskfile(project, file);
      const tasks = new Set<string>();
      const patterns: RegExp[] = [];
      for (const name of declaredTasks) {
        if (name.includes("*")) {
          patterns.push(new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
        } else {
          tasks.add(name);
        }
      }
      return { tasks, patterns, dynamic };
    });
    if (taskfile.dynamic) return [];
    return names
      .filter((t) => !taskfile.tasks.has(t.value) && !taskfile.patterns.some((p) => p.test(t.value)))
      .map((t) => notDefined("Task", t.value, t, `\`${display(project, file)}\``, taskfile.tasks));
  },
};
