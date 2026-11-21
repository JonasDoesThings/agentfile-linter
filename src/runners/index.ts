import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";
import { stripCommandPrefix } from "#src/shell.ts";

import { cargoRunner } from "./cargo.ts";
import { composerRunner } from "./composer.ts";
import { denoRunner } from "./deno.ts";
import { justRunner } from "./just.ts";
import { gradleRunner, mavenRunner } from "./jvm.ts";
import { makeRunner } from "./make.ts";
import { nodeRunners } from "./node.ts";
import { pythonRunners } from "./python.ts";
import { taskRunner } from "./task.ts";
import type { Problem, TaskRunner } from "./types.ts";
import { executableName } from "./util.ts";

export type { Problem, TaskRunner } from "./types.ts";

/** All task runners known to `agentfile/no-missing-script`. */
export const RUNNERS: readonly TaskRunner[] = [
  ...nodeRunners,
  denoRunner,
  makeRunner,
  justRunner,
  taskRunner,
  ...pythonRunners,
  mavenRunner,
  gradleRunner,
  composerRunner,
  cargoRunner,
];

export const RUNNER_IDS = RUNNERS.map((r) => r.id);

/**
 * Checks one simple command. Returns null for an unrecognized command.
 * A disabled runner returns no problems so wrappers respect the opt-out.
 */
export function checkCommand(
  tokens: Token[],
  cwd: string,
  project: Project,
  enabled: (runner: TaskRunner) => boolean = () => true,
  depth = 0,
): Problem[] | null {
  const args = stripCommandPrefix(tokens);
  const executable = args[0];
  if (!executable || depth > 4) return null;
  const name = executableName(executable.value);
  const runner = RUNNERS.find((r) => r.executables.includes(name));
  if (!runner) return null;
  if (!enabled(runner)) return [];
  return runner.check(args, {
    project,
    cwd,
    checkNested: (nested, nestedCwd) => checkCommand(nested, nestedCwd, project, enabled, depth + 1),
  });
}
