import type { Token } from "#src/shell.ts";
import { asRecord } from "#src/util.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, flagValue, notDefined, parseArgs } from "./util.ts";

/** `composer run-script <name>` / `composer run <name>`: scripts from composer.json. */
export const composerRunner: TaskRunner = {
  id: "composer",
  executables: ["composer"],
  check(args: Token[], ctx: RunnerContext): Problem[] {
    const { project } = ctx;
    const parsed = parseArgs(args.slice(1), { valued: ["-d", "--working-dir", "--timeout"] });
    const [command, script] = parsed.positionals;
    // Direct `composer <name>` calls may be plugin commands, so only explicit run-script calls are checked.
    if (!command || !["run-script", "run"].includes(command.value) || !script) return [];
    if (parsed.flags.some((f) => f.name === "-l" || f.name === "--list")) return [];
    const dirFlag = flagValue(parsed, "-d", "--working-dir");
    const dir = dirFlag ? ctx.project.resolveExisting(ctx.cwd, dirFlag.value, "dir") : ctx.cwd;
    const file = project.findUp(dir, ["composer.json"]);
    if (!file)
      return [{ token: script, name: script.value, message: `No composer.json found for \`${script.value}\`` }];
    const scripts = asRecord(asRecord(project.readJson(file)).scripts);
    if (script.value in scripts) return [];
    return [notDefined("Composer script", script.value, script, `\`${display(project, file)}\``, Object.keys(scripts))];
  },
};
