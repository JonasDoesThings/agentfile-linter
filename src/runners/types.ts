import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";

export interface Problem {
  /** Token the problem is reported on. */
  token: Token;
  message: string;
  help?: string;
  /** The script / target / task name, matched against the rule's `ignore` option. */
  name?: string;
}

export interface RunnerContext {
  project: Project;
  /** Absolute directory the command runs in. */
  cwd: string;
  /**
   * Checks a nested command, e.g. `make build` in `uv run make build`.
   * Returns null when the command is unrecognized, or no problems if its runner is disabled.
   */
  checkNested(tokens: Token[], cwd: string): Problem[] | null;
}

/** Knows how to check the commands of one task runner (npm, make, poetry, …). */
export interface TaskRunner {
  /** Identifier used by the rule's `ignoreRunners` option. */
  id: string;
  /** Executable names it handles (basename, without `.exe` / `.cmd` / `.bat`). */
  executables: readonly string[];
  /** `args[0]` is the executable token. */
  check(args: Token[], ctx: RunnerContext): Problem[];
}
