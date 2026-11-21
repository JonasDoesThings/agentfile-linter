import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-missing-script";

const TASKFILE = `version: '3'
includes:
  docs: ./docs
  lib:
    taskfile: ./lib/Tasks.yml
    aliases: [l]
  common:
    taskfile: ./common.yml
    flatten: true
tasks:
  build:
    aliases: [b]
    cmds: [go build]
  "start:*":
    cmds: [echo]
`;

describe("task (go-task)", () => {
  test("checks tasks, aliases, wildcards and namespaced includes", async () => {
    const root = makeProject({
      "Taskfile.yml": TASKFILE,
      "docs/Taskfile.yml": "version: '3'\ntasks:\n  serve: {}\n",
      "lib/Tasks.yml": "version: '3'\ntasks:\n  test: {}\n",
      "common.yml": "version: '3'\ntasks:\n  fmt: {}\n",
      "AGENTS.md": [
        "- `task build b start:web docs:serve lib:test l:test fmt`",
        "- `task CI=true build -- extra args`",
        "- `task docs:build`",
        "- `task biuld`",
        "- `task --list`",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      ["Task `docs:build` is not defined in `Taskfile.yml`", "Available: b, build, docs:serve, fmt, l:test, lib:test"],
      ["Task `biuld` is not defined in `Taskfile.yml`", "Did you mean `build`?"],
    ]);
  });

  test("namespaces wildcard tasks and their aliases, including nested includes", async () => {
    const root = makeProject({
      "Taskfile.yml": [
        "version: '3'",
        "includes:",
        "  child:",
        "    taskfile: ./child.yml",
        "    aliases: [c]",
        "  other: ./child.yml",
      ].join("\n"),
      "child.yml": "version: '3'\nincludes:\n  nested: ./nested.yml\n",
      "nested.yml": "version: '3'\ntasks:\n  'start:*':\n    aliases: ['run:*']\n",
      "AGENTS.md": "`task child:nested:start:api c:nested:run:api other:nested:start:api start:api`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Task `start:api` is not defined in `Taskfile.yml`"]);
  });

  test("falls back to taskipy tasks in pyproject.toml", async () => {
    const root = makeProject({
      "pyproject.toml": '[tool.taskipy.tasks]\ntest = "pytest"\nlint = "ruff check ."\n',
      "AGENTS.md": "`task test` and `task fmt`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Taskipy task `fmt` is not defined in `pyproject.toml`"]);
  });

  test("stays quiet when the project doesn't use go-task or taskipy", async () => {
    const root = makeProject({ "AGENTS.md": "Each `task item` has a title.\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });
});
