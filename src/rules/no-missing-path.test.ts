import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

import { classifyPathCandidate, findImports } from "./no-missing-path.ts";

const RULE = "agentfile/no-missing-path";

describe("classifyPathCandidate", () => {
  test.each([
    ["src/index.ts", "strong"],
    ["./scripts/build", "strong"],
    ["docs/", "strong"],
    ["package.json", "strong"],
    [".env.example", "strong"],
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
    "@scope/package",
    "/etc/hosts",
    "process.env",
    "Node.js",
    ".ts",
    ".d.ts",
    "*.md",
    "path/to/file.ts",
    "src/{id}.ts",
    "src/.../x.ts",
    "foo.ts",
    "your-app/config.json",
    ".gd.uid",
    "Bun.sql",
    "Bun.YAML",
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

describe("agentfile/no-missing-path", () => {
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

  test("resolves against the file directory and its ancestors; `./` paths against the file only", async () => {
    const root = makeProject({
      "packages/a/src/x.ts": "",
      "turbo.json": "{}",
      "packages/a/AGENTS.md": "`src/x.ts`, `packages/a/src/x.ts` and `turbo.json`\n",
      "src/x.ts": "",
      "docs/AGENTS.md": "`./src/x.ts`\n",
    });
    expect((await runRule(root, RULE)).map((d) => `${d.file}: ${d.message}`)).toEqual([
      "docs/AGENTS.md: Path `./src/x.ts` does not exist",
    ]);
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
      ".agentfile-linterrc.json": { rules: { [RULE]: ["error", { allowSuffixMatch: false }] } },
    });
    const diagnostics = await run(strict, { ruleFlags: [{ severity: "off", target: "no-missing-script" }] });
    expect(messages(diagnostics)).toEqual(["Path `components/Button.tsx` does not exist"]);
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

  test("bare names exist anywhere, weak candidates need an existing first segment, modules need no extension", async () => {
    const root = makeProject({
      "packages/a/utils.ts": "",
      "apps/web/": "",
      "src/lib/db.ts": "",
      "AGENTS.md": [
        "`utils.ts` exists, `helpers.ts` does not.",
        "`react-dom/client`, `origin/main`, `apps/web`, `apps/mobile`.",
        "Import from `src/lib/db`.",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Path `helpers.ts` does not exist",
      "Path `apps/mobile` does not exist",
    ]);
  });

  test("skips ignored, link-wrapped and fenced references; accepts compiled artifacts of existing sources", async () => {
    const root = makeProject({
      ".gitignore": "dist/\n.env\n",
      "src/main.ts": "",
      "styles/app.scss": "",
      "AGENTS.md": [
        "`dist/index.js`, `.env`, `node_modules/.bin/tsc`, `.env.example`",
        "",
        "[`src/a.ts`](src/a.ts)",
        "",
        "```sh",
        "cat src/b.ts",
        "```",
        "",
        "`src/main.ts` compiles to `main.js`; `app.css` comes from Sass; `other.js` is missing",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Path `.env.example` does not exist",
      "Path `other.js` does not exist",
    ]);
  });

  test("globs must match a file; parent-relative globs resolve from the context file; literal brackets are paths first", async () => {
    const root = makeProject({
      "src/a.test.ts": "",
      "app/[slug]/page.tsx": "",
      "AGENTS.md": "`src/**/*.test.ts`, `e2e/**/*.spec.ts` and `app/[slug]/page.tsx`\n",
      "docs/[lang]/AGENTS.md": "`../../shared/*.md`, `./guides/*.md` and `../shared/*.md`\n",
      "docs/[lang]/guides/start.md": "",
      "shared/reference.md": "",
    });
    expect((await runRule(root, RULE)).map((d) => `${d.file}: ${d.message}`)).toEqual([
      "AGENTS.md: No files match the glob `e2e/**/*.spec.ts`",
      "docs/[lang]/AGENTS.md: No files match the glob `../shared/*.md`",
    ]);
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

  test("checkImports: false and ignore skip imports and matching paths", async () => {
    const root = makeProject({
      "CLAUDE.md": "@docs/missing.md\n\n`generated/client.ts` and `src/missing.ts`\n",
      ".agentfile-linterrc.json": {
        rules: { [RULE]: ["error", { checkImports: false, ignore: ["generated/**"] }] },
      },
    });
    expect(messages(await run(root))).toEqual(["Path `src/missing.ts` does not exist"]);
  });
});
