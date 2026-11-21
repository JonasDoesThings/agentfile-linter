import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "context/no-missing-script";

describe("deno task", () => {
  test("checks deno.json(c) tasks and package.json scripts", async () => {
    const root = makeProject({
      "deno.jsonc":
        '{\n  // tasks\n  "tasks": { "dev": "deno run -A main.ts", "check": { "command": "deno check" } },\n}\n',
      "package.json": { name: "x", scripts: { build: "vite build" } },
      "AGENTS.md": "`deno task dev`, `deno task check`, `deno task build`, `deno task deploy`, `deno task`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Deno task `deploy` is not defined in `deno.jsonc`"]);
  });

  test("recursive runs check every workspace member", async () => {
    const root = makeProject({
      "deno.json": { workspace: ["./a"], tasks: {} },
      "a/deno.json": { tasks: { test: "deno test" } },
      "AGENTS.md": "`deno task -r test` and `deno task --recursive lint`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Deno task `lint` is not defined in any workspace member"]);
  });

  test("ignores other deno subcommands", async () => {
    const root = makeProject({ "AGENTS.md": "`deno run -A main.ts` and `deno test`\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });
});
