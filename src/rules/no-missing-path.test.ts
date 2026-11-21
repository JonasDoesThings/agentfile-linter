import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

import { classifyPathCandidate, findImports } from "./no-missing-path.ts";

const RULE = "context/no-missing-path";

describe("classifyPathCandidate", () => {
  test.each([
    ["src/index.ts", "strong"],
    ["./scripts/build", "strong"],
    ["../shared/README.md", "strong"],
    ["docs/", "strong"],
    ["package.json", "strong"],
    [".env.example", "strong"],
    [".github/workflows/ci.yml", "strong"],
    ["Makefile", "strong"],
    ["src/**/*.test.ts", "strong"],
    ["src/app.ts:12", "strong"],
    ["src/app.ts#L10-L20", "strong"],
    ["src/components", "weak"],
    ["github.com/org/repo", "weak"],
  ])("%p is a %s candidate", (input, strength) => {
    expect(classifyPathCandidate(input)?.strength).toBe(strength as "strong" | "weak");
  });

  test.each([
    "pnpm dev",
    "https://example.com/x.md",
    "node:fs/promises",
    "@scope/package",
    "/etc/hosts",
    "~/.claude/settings.json",
    "process.env",
    "console.log",
    "Node.js",
    "Next.js",
    ".ts",
    ".d.ts",
    ".test.tsx",
    "*.md",
    "path/to/file.ts",
    "src/<name>.ts",
    "src/{id}.ts",
    "src/.../x.ts",
    "foo.ts",
    "your-app/config.json",
    "useState()",
    "KEY=value",
    "localhost:3000/api",
    "C:\\foo\\bar.ts",
    "TODO",
    ".tscn",
    ".gd.uid",
    "Bun.sql",
    "Bun.YAML",
    "res.json",
    "postgres.js",
  ])("%p is not a path", (input) => {
    expect(classifyPathCandidate(input)).toBeNull();
  });

  test("normalizes leading ./ and trailing /", () => {
    expect(classifyPathCandidate("./src/")).toMatchObject({ path: "src", isDir: true, relativeToFile: true });
  });
});

describe("findImports", () => {
  test("finds file imports but not packages, emails or mentions", () => {
    const text = "See @AGENTS.md and @./docs/a.md, @types/node, mail me@example.com, ping @alice. Also @docs/b.md.";
    expect(findImports(text).map((i) => i.path)).toEqual(["AGENTS.md", "./docs/a.md", "docs/b.md"]);
  });
});

describe("context/no-missing-path", () => {
  test("reports missing files and directories, accepts existing ones", async () => {
    const root = makeProject({
      "src/index.ts": "",
      "docs/guide.md": "",
      "AGENTS.md": [
        "- `src/index.ts` exists",
        "- `src/` and `docs/guide.md` exist",
        "- `src/missing.ts` does not",
        "- `lib/` does not",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual(["Path `src/missing.ts` does not exist", "Directory `lib/` does not exist"]);
    expect(diagnostics[0]).toMatchObject({ line: 3, column: 4 });
  });

  test("resolves against the file directory and its ancestors up to the root", async () => {
    const root = makeProject({
      "packages/a/src/x.ts": "",
      "turbo.json": "{}",
      "packages/a/AGENTS.md": "`src/x.ts`, `packages/a/src/x.ts` and `turbo.json`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("`./` paths are resolved relative to the file only", async () => {
    const root = makeProject({
      "src/x.ts": "",
      "docs/AGENTS.md": "`./src/x.ts`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `./src/x.ts` does not exist"]);
  });

  test("suffix matching accepts partial paths, can be disabled", async () => {
    const root = makeProject({
      "apps/web/src/components/Button.tsx": "",
      "AGENTS.md": "`components/Button.tsx`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
    const strict = makeProject({
      "apps/web/src/components/Button.tsx": "",
      "AGENTS.md": "`components/Button.tsx`\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { allowSuffixMatch: false }] } },
    });
    const diagnostics = await run(strict, { ruleFlags: [{ severity: "off", target: "no-missing-script" }] });
    expect(messages(diagnostics)).toEqual(["Path `components/Button.tsx` does not exist"]);
  });

  test("bare file names must exist somewhere in the project", async () => {
    const root = makeProject({
      "packages/a/utils.ts": "",
      "AGENTS.md": "`utils.ts` exists, `helpers.ts` does not\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `helpers.ts` does not exist"]);
  });

  test("suggests files with the same name", async () => {
    const root = makeProject({
      "src/new/config.ts": "",
      "AGENTS.md": "`src/old/config.ts`\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.help).toBe("Did you mean `src/new/config.ts`?");
  });

  test("weak candidates are only checked when their first segment exists", async () => {
    const root = makeProject({
      "apps/web/": "",
      "AGENTS.md": "`react-dom/client`, `origin/main`, `apps/web`, `apps/mobile`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `apps/mobile` does not exist"]);
  });

  test("extension-less module paths match files with any extension", async () => {
    const root = makeProject({ "src/lib/db.ts": "", "AGENTS.md": "Import from `src/lib/db`.\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("git-ignored and node_modules paths are skipped", async () => {
    const root = makeProject({
      ".gitignore": "dist/\n.env\n",
      "AGENTS.md": "`dist/index.js`, `.env`, `node_modules/.bin/tsc`, `.env.example`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `.env.example` does not exist"]);
  });

  test("globs must match at least one file", async () => {
    const root = makeProject({
      "src/a.test.ts": "",
      "AGENTS.md": "`src/**/*.test.ts` and `e2e/**/*.spec.ts`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["No files match the glob `e2e/**/*.spec.ts`"]);
  });

  test("resolves parent-relative globs from the context file", async () => {
    const root = makeProject({
      "docs/[lang]/AGENTS.md": "`../../shared/*.md`, `./guides/*.md` and `../shared/*.md`\n",
      "docs/[lang]/guides/start.md": "",
      "shared/reference.md": "",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["No files match the glob `../shared/*.md`"]);
  });

  test("literal brackets (Next.js routes) are checked as paths first", async () => {
    const root = makeProject({ "app/[slug]/page.tsx": "", "AGENTS.md": "`app/[slug]/page.tsx`\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("code spans inside links and fenced code blocks are not checked", async () => {
    const root = makeProject({
      "AGENTS.md": "[`src/a.ts`](src/a.ts)\n\n```sh\ncat src/b.ts\n```\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("compiled artifacts of existing sources are accepted", async () => {
    const root = makeProject({
      "src/main.ts": "",
      "styles/app.scss": "",
      "AGENTS.md": "`src/main.ts` compiles to `main.js`; `app.css` comes from Sass; `other.js` is missing\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `other.js` does not exist"]);
  });

  test("example files are not checked", async () => {
    const root = makeProject({
      "AGENTS.md": [
        "Barrel files (e.g., `index.js`, `index.ts` or `mod.ts`) re-export modules. `real.ts` is missing.",
        "",
        "With the following `frontend.tsx`:",
        "",
        "```tsx",
        "export {}",
        "```",
        "",
        "Create `src/routes/new.ts` like this:",
        "",
        "```ts",
        "export {}",
        "```",
        "",
        "```ts#server.ts",
        "Bun.serve({})",
        "```",
        "",
        '```ts title="src/app.ts"',
        "```",
        "",
        "Run `server.ts` and `src/app.ts`.",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Path `real.ts` does not exist"]);
  });

  test("checks @imports relative to the file", async () => {
    const root = makeProject({
      "docs/rules.md": "",
      "CLAUDE.md": "@docs/rules.md\n@docs/missing.md\n\n`@docs/in-code.md` is ignored\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual(["Imported file `@docs/missing.md` does not exist"]);
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 1 });
  });

  test("checkImports: false disables import checks", async () => {
    const root = makeProject({
      "CLAUDE.md": "@docs/missing.md\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { checkImports: false }] } },
    });
    expect(await run(root)).toEqual([]);
  });

  test("ignore option skips matching paths", async () => {
    const root = makeProject({
      "AGENTS.md": "`generated/client.ts` and `src/missing.ts`\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { ignore: ["generated/**"] }] } },
    });
    expect(messages(await run(root))).toEqual(["Path `src/missing.ts` does not exist"]);
  });
});
