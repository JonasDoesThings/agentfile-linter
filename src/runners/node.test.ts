import { describe, expect, test } from "bun:test";

import { tokenize } from "#src/shell.ts";
import { makeProject, messages, runRule } from "#test/helpers.ts";

import { parseScriptInvocation } from "./node.ts";

const RULE = "agentfile/no-missing-script";

function parse(cmd: string, cwd = "/repo") {
  const tokens = tokenize(cmd);
  return tokens ? parseScriptInvocation(tokens, cwd, (base, d) => `${base}/${d}`) : null;
}

describe("parseScriptInvocation", () => {
  test.each([
    ["pnpm dev", "dev", "dir", true],
    ["pnpm run build", "build", "dir", false],
    ["pnpm test", "test", "dir", false],
    ["pnpm -r build", "build", "recursive", true],
    ["pnpm --filter web dev", "dev", "selectors", true],
    ["pnpm -F web dev", "dev", "selectors", true],
    ["pnpm --filter=web run dev", "dev", "selectors", false],
    ["pnpm -w lint", "lint", "workspace-root", true],
    ["pnpm -C apps/web dev", "dev", "dir", true],
    ["npm run build", "build", "dir", false],
    ["npm test", "test", "dir", false],
    ["npm run build --workspace=web", "build", "selectors", false],
    ["npm run build -w web -- --watch", "build", "selectors", false],
    ["npm run build -ws", "build", "recursive", false],
    ["yarn dev", "dev", "dir", true],
    ["yarn run dev", "dev", "dir", true],
    ["yarn workspace web dev", "dev", "selectors", true],
    ["yarn workspaces foreach -A run build", "build", "recursive", true],
    ["bun dev", "dev", "dir", true],
    ["bun run dev", "dev", "dir", true],
    ["bun --filter web dev", "dev", "selectors", true],
  ])("%p -> script %p (%s)", (cmd, script, kind, bin) => {
    const inv = parse(cmd);
    expect(inv).toMatchObject({ script, target: { kind }, allowsBinFallback: bin });
  });

  test.each([
    "pnpm install",
    "pnpm add -D vitest",
    "pnpm exec tsc",
    "pnpm dlx create-vite",
    "npm install",
    "npm ci",
    "npx tsc",
    "yarn",
    "yarn add react",
    "bun test",
    "bun install",
    "bun src/index.ts",
    "bun x tsc",
    "bun -e 'console.log(1)'",
    "pnpm run --if-present lint",
    "npm run build --if-present",
    "pnpm run /^dev:/",
    "pnpm $SCRIPT",
    "git status",
    "pnpm run",
  ])("%p is not a script invocation", (cmd) => {
    expect(parse(cmd)).toBeNull();
  });

  test("-C changes the directory", () => {
    expect(parse("pnpm -C apps/web dev")?.target).toEqual({ kind: "dir", dir: "/repo/apps/web" });
  });
});

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

describe("npm / pnpm / yarn / bun", () => {
  test("checks scripts in the nearest package.json", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": "Run `pnpm build` or `pnpm lint`, not `pnpm dev`.\n",
      "apps/web/AGENTS.md": "Run `pnpm dev` and `npm run build`, not `npm run lint`.\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.message, d.help])).toEqual([
      ["AGENTS.md", "Script `dev` is not defined in `package.json`", "`dev` is defined in `apps/web/package.json`"],
      [
        "apps/web/AGENTS.md",
        "Script `lint` is not defined in `apps/web/package.json`",
        "`lint` is defined in `package.json`",
      ],
    ]);
    expect(diagnostics[0]).toMatchObject({ line: 1, column: 44 });
  });

  test("resolves workspace filters by name, unscoped name, path and glob", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "- `pnpm --filter @acme/web dev`",
        "- `pnpm --filter web dev`",
        "- `pnpm --filter ./packages/ui storybook`",
        "- `pnpm --filter '@acme/*' storybook`",
        "- `pnpm --filter web... build`",
        "- `pnpm --filter ui dev`",
        "- `pnpm --filter mobile dev`",
        "- `pnpm --filter internal secret`",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `dev` is not defined in `packages/ui/package.json`",
      "No workspace package matches `mobile` (running `dev`)",
      "No workspace package matches `internal` (running `secret`)",
    ]);
  });

  test("supports npm, yarn and bun workspace syntax", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "- `npm run dev -w @acme/web`",
        "- `npm run dev --workspace=apps/web`",
        "- `yarn workspace @acme/ui storybook`",
        "- `yarn workspace @acme/ui dev`",
        "- `bun --filter @acme/web dev`",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Script `dev` is not defined in `packages/ui/package.json`"]);
  });

  test("npm requires the script in each selected workspace unless --if-present is set", async () => {
    const root = makeProject({
      ...workspace,
      "apps/web/server.js": "",
      "AGENTS.md": [
        "`npm run dev -w @acme/web -w @acme/ui`",
        "`npm run dev -w @acme/web -w @acme/ui --if-present`",
        "`npm run build -w @acme/web -w @acme/ui`",
        "`npm start -w @acme/web -w @acme/ui`",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `dev` is not defined in `packages/ui/package.json`",
      "Script `start` is not defined in `packages/ui/package.json`",
    ]);
  });

  test("recursive runs need the script in at least one workspace package", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "`pnpm -r storybook` works and `pnpm -r deploy` is a pnpm built-in.",
        "`pnpm -r lint` is defined only at the root.",
        "`pnpm -r --include-workspace-root run lint` includes the root.",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `lint` is not defined in any of the 2 targeted packages",
    ]);
  });

  test("pnpm can include the root from workspace settings and override it on the command line", async () => {
    const root = makeProject({
      ...workspace,
      "pnpm-workspace.yaml": `${workspace["pnpm-workspace.yaml"]}includeWorkspaceRoot: true\n`,
      "AGENTS.md": "`pnpm -r lint`\n`pnpm -r --include-workspace-root=false run lint`\n",
    });
    expect((await runRule(root, RULE)).map(({ line, message }) => [line, message])).toEqual([
      [2, "Script `lint` is not defined in any of the 2 targeted packages"],
    ]);
  });

  test("npm --workspaces checks every declared member and excludes the root by default", async () => {
    const root = makeProject({
      ...workspace,
      "package.json": {
        ...workspace["package.json"],
        workspaces: ["apps/*", "packages/ui"],
      },
      "pnpm-workspace.yaml": "packages: [apps/*]\n",
      "AGENTS.md": [
        "`npm run dev --workspaces`",
        "`npm run dev -ws`",
        "`npm run dev --workspaces --if-present`",
        "`npm run lint --workspaces=false`",
        "`npm run build --workspaces`",
        "`npm run lint --workspaces --include-workspace-root`",
      ].join("\n"),
    });
    expect((await runRule(root, RULE)).map(({ line, message }) => [line, message])).toEqual([
      [1, "Script `dev` is not defined in `packages/ui/package.json`"],
      [2, "Script `dev` is not defined in `packages/ui/package.json`"],
      [6, "Script `lint` is not defined in `apps/web/package.json`, `packages/ui/package.json`"],
    ]);
  });

  test("falls back to binaries for pnpm/yarn/bun but not for npm run", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": "`pnpm tsc --noEmit`, `pnpm turbo build`, `yarn tsc`, `npm run tsc`, `pnpm eslint .`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `tsc` is not defined in `package.json`",
      "Script `eslint` is not defined in `package.json`",
    ]);
  });

  test("without any package.json, scripts are reported", async () => {
    const root = makeProject({ "AGENTS.md": "`npm run build`\n" });
    expect(messages(await runRule(root, RULE))).toEqual([
      "No package.json found for `build` (run from the project root)",
    ]);
  });

  test("Bun accepts existing local entry files without a package.json", async () => {
    const root = makeProject({
      "AGENTS.md": "`bun run tool.ts`, `bun tool.ts` and `bun run tool`\n",
      "tool.ts": "console.log('TypeScript entry point');\n",
      tool: "console.log('Extensionless entry point');\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("Bun checks entry files in the command's working directory", async () => {
    const root = makeProject({
      "package.json": { name: "root", scripts: { dev: "echo dev" } },
      "AGENTS.md": [
        "`bun --cwd docs run tool.ts` and `bun run dev` work.",
        "`bun run tool.ts` is missing here.",
        "`bun run output` names a directory.",
        "`npm run root.ts` requires a package script.",
      ].join("\n"),
      "docs/tool.ts": "",
      "output/.keep": "",
      "root.ts": "",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Script `tool.ts` is not defined in `package.json`",
      "Script `output` is not defined in `package.json`",
      "Script `root.ts` is not defined in `package.json`",
    ]);
  });

  test("npm start falls back to server.js", async () => {
    const root = makeProject({ "package.json": { name: "x" }, "server.js": "", "AGENTS.md": "`npm start`\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("npm restart also falls back to npm start", async () => {
    const root = makeProject({
      "app/package.json": { name: "app", scripts: { start: "node app.js" } },
      "app/AGENTS.md": "`npm restart` and `npm run restart`\n",
      "server/package.json": { name: "server" },
      "server/server.js": "",
      "server/AGENTS.md": "`npm restart`\n",
      "empty/package.json": { name: "empty", scripts: { stop: "echo stopped" } },
      "empty/AGENTS.md": "`npm restart`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Script `restart` is not defined in `empty/package.json`"]);
  });
});
