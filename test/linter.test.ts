import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { ConfigError } from "#src/config.ts";
import { collectFiles, lint } from "#src/linter.ts";

import { makeProject, messages, run } from "./helpers.ts";

describe("file discovery", () => {
  test("finds context files in nested directories, respecting .gitignore", async () => {
    const root = makeProject({
      ".gitignore": "ignored/\n",
      "AGENTS.md": "",
      "AGENT.md": "",
      "CLAUDE.local.md": "",
      ".claude/CLAUDE.md": "",
      "packages/a/GEMINI.md": "",
      "ignored/AGENTS.md": "",
      "node_modules/pkg/AGENTS.md": "",
      "README.md": "",
    });
    const result = await lint({ cwd: root, config: false });
    expect(result.files.map((f) => f.filePath.slice(root.length + 1))).toEqual([
      ".claude/CLAUDE.md",
      "AGENT.md",
      "AGENTS.md",
      "CLAUDE.local.md",
      "packages/a/GEMINI.md",
    ]);
  });

  test("a root .gitignore overrides .git/info/exclude", async () => {
    const root = makeProject({
      ".gitignore": "!AGENTS.md\nCLAUDE.md\n",
      ".git/info/exclude": "AGENTS.md\n!CLAUDE.md\nGEMINI.md\n",
      "AGENTS.md": "",
      "CLAUDE.md": "",
      "GEMINI.md": "",
    });
    expect(collectFiles({ cwd: root, config: false })).toEqual([join(root, "AGENTS.md")]);
  });

  test.each([
    ["unset", false],
    ["false", false],
    ["true", true],
  ])("Git ignore case follows core.ignoreCase=%s", (setting, ignored) => {
    const root = makeProject({
      ".gitignore": "vendor/\n",
      "Vendor/AGENTS.md": "",
      ...(setting === "unset" ? {} : { ".git/config": `[core]\n\tignoreCase = ${setting}\n` }),
    });
    expect(collectFiles({ cwd: root, config: false })).toEqual(ignored ? [] : [join(root, "Vendor", "AGENTS.md")]);
  });

  test("reads the common Git config in a linked worktree", () => {
    const root = makeProject(
      {
        ".git": "gitdir: .metadata/worktrees/local\n",
        ".metadata/worktrees/local/commondir": "../..\n",
        ".metadata/config": "[core]\n\tignorecase = true\n",
        ".gitignore": "vendor/\n",
        "Vendor/AGENTS.md": "",
      },
      { git: false },
    );
    expect(collectFiles({ cwd: root, config: false })).toEqual([]);
  });

  test("--no-ignore includes git-ignored files (but never node_modules)", async () => {
    const root = makeProject({
      ".gitignore": "ignored/\n",
      "ignored/AGENTS.md": "",
      "node_modules/pkg/AGENTS.md": "",
    });
    const result = await lint({ cwd: root, config: false, noIgnore: true });
    expect(result.files.map((f) => f.filePath.slice(root.length + 1))).toEqual(["ignored/AGENTS.md"]);
  });

  test("ignorePatterns, --ignore-pattern and .contextlintignore", async () => {
    const root = makeProject({
      ".contextlintrc.json": { ignorePatterns: ["vendor/"] },
      ".contextlintignore": "# comment\nlegacy/\n",
      "vendor/AGENTS.md": "",
      "legacy/AGENTS.md": "",
      "tmp/AGENTS.md": "",
      "AGENTS.md": "",
    });
    const result = await lint({ cwd: root, ignorePatterns: ["tmp/**"] });
    expect(result.files.map((f) => f.filePath.slice(root.length + 1))).toEqual(["AGENTS.md"]);
  });

  test("explicit paths: files are linted regardless of name, directories are walked", async () => {
    const root = makeProject({
      "docs/agent-guide.md": "`missing.ts`\n",
      "packages/a/AGENTS.md": "",
      "packages/b/AGENTS.md": "",
    });
    const result = await lint({ cwd: root, config: false, paths: ["docs/agent-guide.md", "packages/a"] });
    expect(result.files.map((f) => f.filePath.slice(root.length + 1))).toEqual([
      "docs/agent-guide.md",
      "packages/a/AGENTS.md",
    ]);
    expect(result.errorCount).toBe(1);
  });

  test("external directories without Git metadata share a scan root", async () => {
    const root = makeProject(
      {
        "caller/": "",
        "repo/.gitignore": "docs/CLAUDE.md\n",
        "repo/package.json": { scripts: { build: "echo build" } },
        "repo/docs/AGENTS.md": "`npm run build`\n",
        "repo/docs/CLAUDE.md": "`missing.ts`\n",
      },
      { git: false },
    );
    const options = { cwd: join(root, "caller"), config: false as const, paths: ["../repo/docs", "../repo"] };
    // An explicitly named subdirectory and the enclosing directory use the same project.
    expect(collectFiles(options)).toEqual([join(root, "repo", "docs", "AGENTS.md")]);
    expect(await lint(options)).toMatchObject({ fileCount: 1, errorCount: 0 });
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable directories and continues linting readable files",
    async () => {
      const root = makeProject({ "AGENTS.md": "`missing.ts`\n", "private/AGENTS.md": "" });
      const dir = join(root, "private");
      chmodSync(dir, 0o000);
      try {
        expect(await lint({ cwd: root, config: false })).toMatchObject({ fileCount: 1, errorCount: 2 });
        expect(messages(await run(root, { config: false }))).toEqual([
          "Path `missing.ts` does not exist",
          "Cannot read directory (EACCES)",
        ]);
        expect(() => collectFiles({ cwd: root, config: false })).toThrow("Cannot read directories: private (EACCES)");
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  test("missing input paths are an error", async () => {
    const root = makeProject({});
    const error = await lint({ cwd: root, paths: ["nope"] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("No such file or directory: nope");
  });

  test("broken symlinks are reported", async () => {
    const root = makeProject({ "AGENTS.md": "", "CLAUDE.md": { symlink: "docs/gone.md" } });
    expect(await run(root, { config: false })).toEqual([
      expect.objectContaining({ file: "CLAUDE.md", rule: null, message: "Cannot read file (broken symbolic link)" }),
    ]);
  });
});

describe("inline suppressions", () => {
  test("disable-next-line, disable-line, and disable/enable ranges", async () => {
    const root = makeProject({
      "AGENTS.md": [
        "<!-- contextlint-disable-next-line context/no-missing-path -->",
        "`a.ts`",
        "`b.ts` <!-- contextlint-disable-line -->",
        "`c.ts` <!-- contextlint-disable-line no-broken-reference -->",
        "",
        "<!-- contextlint-disable no-missing-path -- generated section -->",
        "`d.ts`",
        "<!-- contextlint-enable no-missing-path -->",
        "`e.ts`",
        "",
        "<!-- contextlint-disable -->",
        "`f.ts`",
        "",
      ].join("\n"),
    });
    expect(messages(await run(root, { config: false }))).toEqual([
      "Path `c.ts` does not exist",
      "Path `e.ts` does not exist",
    ]);
  });

  test("unknown rule names are reported as info at their location", async () => {
    const root = makeProject({
      "AGENTS.md": [
        "---",
        "# contextlint-disable-line no-missing-pth, context/no-missing-path",
        "---",
        "<!-- contextlint-disable-next-line no-mising-coasfasas -->",
        "`a.ts` <!-- contextlint-disable-line context/no-missing-path no-broken-reference -- because -->",
        "",
        "> <!-- contextlint-disable no-missing-path,nope -->",
        "",
        "- item",
        "  <!-- contextlint-enable",
        "  no-missing-path typo -->",
        "",
        "`b.ts` <!-- contextlint-disable-line no-missing-path missing file -->",
        "",
      ].join("\n"),
    });
    const result = await lint({ cwd: root, config: false });
    expect(result).toMatchObject({ errorCount: 0, warningCount: 0 });
    const notes = (await run(root, { config: false })).map(({ line, column, message, help, severity, rule }) => ({
      at: `${line}:${column}`,
      message,
      help,
      severity,
      rule,
    }));
    const other = expect.stringContaining("`contextlint --rules` lists all rules");
    expect(notes).toEqual([
      {
        at: "2:28",
        message: "Unknown rule `no-missing-pth` in `contextlint-disable-line` directive",
        help: "Did you mean `context/no-missing-path`?",
        severity: "info",
        rule: null,
      },
      {
        at: "4:36",
        message: "Unknown rule `no-mising-coasfasas` in `contextlint-disable-next-line` directive",
        help: other,
        severity: "info",
        rule: null,
      },
      { at: "7:44", message: expect.stringContaining("`nope`"), help: other, severity: "info", rule: null },
      { at: "11:19", message: expect.stringContaining("`typo`"), help: other, severity: "info", rule: null },
      // Without ` -- `, a reason is read as rule names.
      { at: "13:54", message: expect.stringContaining("`missing`"), help: other, severity: "info", rule: null },
      { at: "13:62", message: expect.stringContaining("`file`"), help: other, severity: "info", rule: null },
    ]);
  });

  test("unknown rule names in files that only tree rules check are reported", async () => {
    const root = makeProject({
      "AGENTS.md": "",
      ".agents/skills/demo/SKILL.md": [
        "---",
        "# contextlint-disable-next-line no-invalid-skil",
        "name: demo",
        "description: Does the thing. Use when the user asks for it.",
        "---",
        "",
      ].join("\n"),
      ".agents/skills/body/SKILL.md":
        "---\nname: body\ndescription: Does the thing. Use when the user asks for it.\n---\n\n<!-- contextlint-disable typo -->\n",
    });
    // Skills are only scanned where the rule that checks them is on.
    const ruleFlags = [{ severity: "off" as const, target: "no-invalid-skill" }];
    expect(await run(root, { config: false, ruleFlags })).toEqual([]);
    expect(await run(root, { config: false })).toEqual([
      expect.objectContaining({ file: ".agents/skills/body/SKILL.md", line: 6, column: 26, severity: "info" }),
      expect.objectContaining({
        file: ".agents/skills/demo/SKILL.md",
        line: 2,
        column: 33,
        severity: "info",
        help: "Did you mean `context/no-invalid-skill`?",
      }),
    ]);
  });
});

describe("results", () => {
  test("counts files, rules, errors and warnings", async () => {
    const root = makeProject({ "AGENTS.md": "`a.ts` `pnpm dev`\n" });
    const result = await lint({
      cwd: root,
      config: false,
      ruleFlags: [{ severity: "warn", target: "no-missing-script" }],
    });
    expect(result).toMatchObject({ fileCount: 1, ruleCount: 4, errorCount: 1, warningCount: 1 });
  });
});
