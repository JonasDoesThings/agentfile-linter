import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-missing-script";

const workspace = {
  "package.json": {
    name: "root",
    scripts: { build: "turbo build", lint: "oxlint" },
    devDependencies: { turbo: "2", typescript: "5" },
  },
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n  - '!packages/internal'\n",
  "apps/web/package.json": { name: "@acme/web", scripts: { dev: "vite", build: "vite build" } },
  "packages/ui/package.json": { name: "@acme/ui", scripts: { build: "tsup", storybook: "storybook dev" } },
  "packages/internal/package.json": { name: "@acme/internal", scripts: { secret: "x" } },
};

describe("agentfile/no-missing-script", () => {
  test("tracks `cd` in commands and code blocks", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "`cd apps/web && pnpm dev`",
        "",
        "```bash",
        "cd packages/ui",
        "pnpm storybook",
        "pnpm dev",
        "cd ../../does-not-exist",
        "pnpm whatever",
        "```",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual(["Script `dev` is not defined in `packages/ui/package.json`"]);
    expect(diagnostics[0]).toMatchObject({ line: 6, column: 6 });
  });

  test("restores the working directory after nested subshells", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "`(cd apps/web && pnpm dev) && pnpm lint`",
        "",
        "```bash",
        "(cd apps/web",
        "  (cd ../../packages/ui && pnpm storybook; pnpm missing)",
        "  pnpm dev",
        ")",
        "pnpm lint",
        "```",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual(["Script `missing` is not defined in `packages/ui/package.json`"]);
    expect(diagnostics[0]).toMatchObject({ line: 5, column: 49 });
  });

  test("pipeline commands do not change the surrounding Bash working directory", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "`cd apps/web | cat; pnpm lint`",
        "",
        "```bash",
        "cd apps/web | cat",
        "pnpm lint",
        "echo hello |",
        "  cd apps/web",
        "pnpm lint",
        "(cd apps/web && pnpm dev) |& cd packages/ui",
        "pnpm lint",
        "cd apps/web && pnpm dev",
        "pnpm stale",
        "```",
      ].join("\n"),
    });
    expect((await runRule(root, RULE)).map(({ line, message }) => [line, message])).toEqual([
      [12, "Script `stale` is not defined in `apps/web/package.json`"],
    ]);
  });

  test("locates aliases and continued commands at the written source tokens", async () => {
    const root = makeProject({
      "package.json": {},
      "AGENTS.md": [
        "<!-- agentfile-linter-disable-next-line no-missing-script -->",
        "`npm t`",
        "",
        "A mention of test later in the file.",
        "`npm tst`",
        "",
        "```bash",
        "pnpm run \\",
        '  "missing script"',
        "```",
        "",
        "> ```console",
        '> $ npm run "also-missing"',
        "> ```",
        "",
        "> `npm",
        "> t`",
      ].join("\r\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map(({ line, column, message }) => [line, column, message])).toEqual([
      [5, 6, "Script `test` is not defined in `package.json`"],
      [9, 4, "Script `missing script` is not defined in `package.json`"],
      [13, 14, "Script `also-missing` is not defined in `package.json`"],
      [17, 3, "Script `test` is not defined in `package.json`"],
    ]);
  });

  test("`cd` and directory flags in nested docs fall back to the project root", async () => {
    const root = makeProject({
      ...workspace,
      Makefile: "build:\n\techo\n",
      "docs/AGENTS.md": "`cd apps/web && pnpm dev`, `cd apps/web && pnpm nope`, `pnpm -C packages/ui storybook`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Script `nope` is not defined in `apps/web/package.json`"]);
  });

  test("lone tool names in prose are mentions; in code blocks they are commands", async () => {
    const root = makeProject({
      "AGENTS.md": "We use `make`, `just` and `mvn`.\n\n```sh\nmake\n```\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["No Makefile found for `make`"]);
  });

  test("only checks shell-like code blocks", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md":
        "```yaml\nrun: pnpm nope\n```\n\n```\npnpm nope2\n```\n\n```console\n$ pnpm nope3\npnpm nope4\n```\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `nope2` is not defined in `package.json`",
      "Script `nope3` is not defined in `package.json`",
    ]);
  });

  test("ignore option skips script names", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": "`pnpm release:canary` and `pnpm nope`\n",
      ".agentfile-linterrc.json": { rules: { [RULE]: ["error", { ignore: ["release:*"] }] } },
    });
    expect(messages(await run(root))).toEqual(["Script `nope` is not defined in `package.json`"]);
  });

  test("ignoreRunners disables a runner", async () => {
    const root = makeProject({
      Makefile: "build:\n\techo\n",
      "AGENTS.md": "`make nope` and `pnpm nope`\n",
      "package.json": { name: "x" },
      ".agentfile-linterrc.json": { rules: { [RULE]: ["error", { ignoreRunners: ["make"] }] } },
    });
    expect(messages(await run(root))).toEqual(["Script `nope` is not defined in `package.json`"]);
  });

  test("run wrappers honor runner opt-outs and continue checking other commands", async () => {
    const root = makeProject({
      Makefile: "build:\n\techo\n",
      justfile: "build:\n  echo\n",
      "pyproject.toml": '[project]\nname = "x"\n[tool.poe.tasks]\nlint = "ruff check"\n',
      "AGENTS.md": "`uv run make nope`, `poetry poe nope`, `uv run just nope` and `uv run unknown`\n",
      ".agentfile-linterrc.json": { rules: { [RULE]: ["error", { ignoreRunners: ["make", "poe"] }] } },
    });
    expect(messages(await run(root))).toEqual([
      "Just recipe `nope` is not defined in `justfile`",
      "uv script `unknown` is not defined in `pyproject.toml`, and no dependency provides a `unknown` command",
    ]);
  });

  test("handles several runners in one document", async () => {
    const root = makeProject({
      "package.json": { name: "x", scripts: { dev: "vite" } },
      Makefile: "test:\n\techo\n",
      justfile: "lint:\n  echo\n",
      "AGENTS.md": ["```sh", "pnpm dev", "make test", "just lint", "just fmt", "make tset", "```", ""].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [5, "Just recipe `fmt` is not defined in `justfile`"],
      [6, "Make target `tset` is not defined in `Makefile`"],
    ]);
  });
});
