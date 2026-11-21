import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { lint } from "#src/linter.ts";
import { commit, makeProject, run, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-unnecessary-agent-files";
const CONTENT = "# Agents\n\nUse pnpm.\n";

const summary = async (root: string) =>
  (await runRule(root, RULE)).map((d) => [d.file, d.line, d.message, d.help?.match(/\(`(.+)`\)\.$/)?.[1]]);

describe("agentfile/no-unnecessary-agent-files", () => {
  test("CLAUDE.md symlinked to AGENTS.md is reported once", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": { symlink: "AGENTS.md" } });
    commit(root);
    expect(await summary(root)).toEqual([
      ["CLAUDE.md", 1, "`CLAUDE.md` is a symlink to `AGENTS.md` and is not needed", "git rm CLAUDE.md"],
    ]);
  });

  test("untracked files and projects outside Git get commands without git", async () => {
    const untracked = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": CONTENT });
    commit(untracked, { paths: ["AGENTS.md"] });
    expect((await summary(untracked)).map((d) => d[3])).toEqual(["rm CLAUDE.md"]);

    const noGit = makeProject({ "app/CLAUDE.md": CONTENT, "app/AGENTS.md": { symlink: "CLAUDE.md" } }, { git: false });
    expect((await summary(noGit)).map((d) => d[3])).toEqual([
      'rm "./app/AGENTS.md" && mv "./app/CLAUDE.md" "./app/AGENTS.md"',
    ]);
  });

  test.each([
    ["git-ignored", { ".gitignore": "AGENTS.md\n" }],
    ["untracked", {}],
  ])("a committed CLAUDE.md next to a %s AGENTS.md is kept", async (_, extra) => {
    const root = makeProject({ ...extra, "AGENTS.md": CONTENT, "CLAUDE.md": CONTENT });
    commit(root, { paths: ["CLAUDE.md", ...Object.keys(extra)] });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("AGENTS.md symlinked to CLAUDE.md suggests making AGENTS.md the real file", async () => {
    const root = makeProject({ "CLAUDE.md": CONTENT, "AGENTS.md": { symlink: "CLAUDE.md" } });
    commit(root);
    expect(await summary(root)).toEqual([
      [
        "CLAUDE.md",
        1,
        "`AGENTS.md` is a symlink to `CLAUDE.md`; `CLAUDE.md` is not needed",
        "rm AGENTS.md && git mv CLAUDE.md AGENTS.md",
      ],
    ]);
  });

  test("both files linked to a third file", async () => {
    const root = makeProject({
      "docs/ai.md": CONTENT,
      "AGENTS.md": { symlink: "docs/ai.md" },
      "CLAUDE.md": { symlink: "docs/ai.md" },
    });
    expect((await summary(root)).map((d) => d[2])).toEqual([
      "`AGENTS.md` and `CLAUDE.md` both link to `docs/ai.md`; `CLAUDE.md` is not needed",
    ]);
  });

  test("suggested commands operate on the reported pair from the lint working directory", async () => {
    const root = makeProject({
      "AGENTS.md": "Root instructions",
      "app one/AGENTS.md": { symlink: "CLAUDE.md" },
      "app one/CLAUDE.md": CONTENT,
      "app two/AGENTS.md": CONTENT,
      "app two/CLAUDE.md": { symlink: "AGENTS.md" },
    });
    commit(root);
    const diagnostics = await summary(root);
    expect(diagnostics.map(([file]) => file)).toEqual(["app one/CLAUDE.md", "app two/CLAUDE.md"]);
    for (const [, , , command] of diagnostics) {
      if (typeof command !== "string") throw new Error("Missing command in diagnostic");
      const result = Bun.spawnSync([process.execPath, "exec", command], { cwd: root });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Root instructions");
    for (const dir of ["app one", "app two"]) {
      expect(existsSync(join(root, dir, "CLAUDE.md"))).toBe(false);
      expect(lstatSync(join(root, dir, "AGENTS.md")).isFile()).toBe(true);
      expect(readFileSync(join(root, dir, "AGENTS.md"), "utf8")).toBe(CONTENT);
    }
  });

  test("paths containing shell metacharacters get file-specific prose", async () => {
    const root = makeProject({ "$app/AGENTS.md": CONTENT, "$app/CLAUDE.md": CONTENT });
    const [diagnostic] = await runRule(root, RULE);
    expect(diagnostic?.help).toEndWith("Delete `$app/CLAUDE.md`.");
  });

  test("a symlink chain gets safe deletion instructions", async () => {
    const root = makeProject({
      "docs/ai.md": CONTENT,
      "CLAUDE.md": { symlink: "docs/ai.md" },
      "AGENTS.md": { symlink: "CLAUDE.md" },
    });
    const [diagnostic] = await runRule(root, RULE);
    expect(diagnostic?.help).toContain(
      "Make sure `AGENTS.md` links directly to `docs/ai.md` before deleting `CLAUDE.md`.",
    );
  });

  test("an identical copy is reported on CLAUDE.md", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": CONTENT.replace(/\n/g, "\r\n") });
    expect(await summary(root)).toEqual([
      ["CLAUDE.md", 1, "`CLAUDE.md` is a copy of `AGENTS.md` and is not needed", "rm CLAUDE.md"],
    ]);
  });

  test("a CLAUDE.md reached by another file's symlink chain is retained", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "docs/instructions.md": { symlink: "../CLAUDE.md" },
      "app/GEMINI.md": { symlink: "../docs/instructions.md" },
      ".gitignore": "docs/\n",
    });
    expect(await summary(root)).toEqual([]);
  });

  test("an independent symlink to AGENTS.md still allows removal", async () => {
    const root = makeProject({
      "AGENTS.md": { symlink: "CLAUDE.md" },
      "CLAUDE.md": CONTENT,
      "GEMINI.md": { symlink: "AGENTS.md" },
    });
    expect((await summary(root)).map(([path]) => path)).toEqual(["CLAUDE.md"]);
  });

  test("a CLAUDE.md imported by other instructions is retained", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": CONTENT,
      "app/GEMINI.md": "Use these instructions.\n\n@../docs/shared.md\n",
      "docs/shared.md": "@../CLAUDE.md\n",
    });
    expect(await summary(root)).toEqual([]);
  });

  test("CLAUDE.md files in .claude directories are retained", async () => {
    const root = makeProject({ ".claude/AGENTS.md": CONTENT, ".claude/CLAUDE.md": CONTENT });
    expect(await runRule(root, RULE, { paths: [".claude"] })).toEqual([]);
  });

  test("results don't depend on the home directory or Claude Code's config directory", () => {
    const root = makeProject({ "settings/AGENTS.md": CONTENT, "settings/CLAUDE.md": CONTENT });
    const cli = join(import.meta.dir, "..", "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "-A", "all", "-W", RULE, "settings"], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "settings") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stdout.toString()).toContain("`CLAUDE.md` is a copy of `AGENTS.md` and is not needed");
  });

  test("files above the project root are not considered", async () => {
    const outer = makeProject(
      {
        "CLAUDE.md": "# Instructions for everything in this folder\n",
        "repo/.git/": "",
        "repo/AGENTS.md": CONTENT,
        "repo/CLAUDE.md": { symlink: "AGENTS.md" },
      },
      { git: false },
    );
    expect(await summary(join(outer, "repo"))).toEqual([
      ["CLAUDE.md", 1, "`CLAUDE.md` is a symlink to `AGENTS.md` and is not needed", "rm CLAUDE.md"],
    ]);
  });

  test("git-ignored directories are not searched for retained files", async () => {
    const root = makeProject({
      ".gitignore": "vendor/\n",
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "vendor/lib/CLAUDE.md": "# Vendored instructions\n",
    });
    expect((await summary(root)).map(([path]) => path)).toEqual(["CLAUDE.md"]);
  });

  test.each([".claude/rules/style.md", ".claude/commands/review.md", ".claude/skills/review/SKILL.md"])(
    "a CLAUDE.md imported by %s is retained",
    async (importer) => {
      const depth = importer.split("/").length - 1;
      const root = makeProject({
        "AGENTS.md": CONTENT,
        "CLAUDE.md": { symlink: "AGENTS.md" },
        [importer]: `Follow the project rules.\n\n@${"../".repeat(depth)}CLAUDE.md\n`,
      });
      expect(await summary(root)).toEqual([]);
    },
  );

  test("a CLAUDE.md imported by a git-ignored CLAUDE.local.md is retained", async () => {
    const root = makeProject({
      ".gitignore": "CLAUDE.local.md\n",
      "packages/a/AGENTS.md": CONTENT,
      "packages/a/CLAUDE.md": { symlink: "AGENTS.md" },
      "packages/b/CLAUDE.local.md": "@../a/CLAUDE.md\n",
    });
    expect(await summary(root)).toEqual([]);
  });

  test.each(["@AGENTS.md\n", "<!-- Claude Code -->\n@./AGENTS.md\n"])(
    "a CLAUDE.md of %j is reported",
    async (pointer) => {
      const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": pointer });
      expect((await summary(root)).map((d) => d[2])).toEqual([
        "`CLAUDE.md` only imports `AGENTS.md` and is not needed",
      ]);
    },
  );

  test("a CLAUDE.md with content of its own is fine", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": "@AGENTS.md\n\nPrefer the Bash tool for git.\n",
      "a/AGENTS.md": CONTENT,
      "a/CLAUDE.md": "@AGENTS.md @docs/claude.md\n",
      "a/docs/claude.md": "Claude only.\n",
      "b/AGENTS.md": CONTENT,
      "b/CLAUDE.md": "# Different\n",
      "c/CLAUDE.md": CONTENT,
      "d/AGENTS.md": CONTENT,
      "d/GEMINI.md": { symlink: "AGENTS.md" },
    });
    expect(await summary(root)).toEqual([]);
  });

  test("pairs are per directory", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "packages/a/AGENTS.md": CONTENT,
      "packages/a/CLAUDE.md": "@AGENTS.md\n",
      "packages/b/AGENTS.md": CONTENT,
      "packages/b/CLAUDE.md": "# Claude\n",
    });
    expect((await summary(root)).map((d) => d[0])).toEqual(["packages/a/CLAUDE.md"]);
  });

  test.each(["CLAUDE.local.md", ".claude/CLAUDE.md"])(
    "a %s keeps Claude Code from reading AGENTS.md",
    async (blocker) => {
      const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": "@AGENTS.md\n", [blocker]: "Mine.\n" });
      expect(await summary(root)).toEqual([]);
    },
  );

  test("a CLAUDE.md with content in a parent directory keeps Claude Code from reading AGENTS.md", async () => {
    const nested = makeProject({
      "CLAUDE.md": "# Root instructions for Claude\n",
      "packages/a/AGENTS.md": CONTENT,
      "packages/a/CLAUDE.md": { symlink: "AGENTS.md" },
    });
    expect(await summary(nested)).toEqual([]);
  });

  test("redundant CLAUDE.md files in parent directories don't block", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "packages/a/AGENTS.md": CONTENT,
      "packages/a/CLAUDE.md": "@AGENTS.md\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map(({ file }) => file)).toEqual(["CLAUDE.md", "packages/a/CLAUDE.md"]);
    expect(diagnostics.map(({ help }) => help)).toEqual([
      expect.stringContaining("Apply the suggested removals under `.` together."),
      expect.stringContaining("Apply the suggested removals under `.` together."),
    ]);
  });

  test.each(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"])(
    "a retained %s in a subdirectory keeps its ancestor's CLAUDE.md necessary",
    async (blocker) => {
      const root = makeProject({
        ".gitignore": "app/CLAUDE.local.md\n",
        "AGENTS.md": CONTENT,
        "CLAUDE.md": "@AGENTS.md\n",
        [`app/${blocker}`]: "# App instructions\n",
      });
      expect(await summary(root)).toEqual([]);
    },
  );

  test("a redundant parent outside the selected scope stays necessary", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": "@AGENTS.md\n",
      "app/AGENTS.md": CONTENT,
      "app/CLAUDE.md": "@AGENTS.md\n",
    });
    expect(await runRule(root, RULE, { paths: ["app"] })).toEqual([]);
    expect(await runRule(root, RULE, { ignorePatterns: ["/CLAUDE.md"] })).toEqual([]);
  });

  test("an override can retain a parent CLAUDE.md symlink", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "app/AGENTS.md": CONTENT,
      "app/CLAUDE.md": "@AGENTS.md\n",
      ".agentfile-linterrc.json": {
        categories: { recommended: "off" },
        rules: { [RULE]: "warn" },
        overrides: [{ files: ["/CLAUDE.md"], rules: { [RULE]: "off" } }],
      },
    });
    expect(await run(root)).toEqual([]);
  });

  test("a symlink excluded by the files allowlist is retained", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "app/AGENTS.md": CONTENT,
      "app/CLAUDE.md": "@AGENTS.md\n",
      ".agentfile-linterrc.json": {
        files: ["AGENTS.md", "app/CLAUDE.md"],
        categories: { recommended: "off" },
        rules: { [RULE]: "warn" },
      },
    });
    expect(await run(root)).toEqual([]);
  });

  test("a symlink uses its own severity override and shares the context file count", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      ".agentfile-linterrc.json": {
        categories: { recommended: "off" },
        overrides: [{ files: ["CLAUDE.md"], rules: { [RULE]: "warn" } }],
      },
    });
    const result = await lint({ cwd: root });
    const diagnostics = result.files.flatMap((file) => file.diagnostics);
    expect(result.fileCount).toBe(1);
    expect(result.files.map(({ filePath }) => filePath)).toEqual([join(root, "CLAUDE.md")]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ filePath: join(root, "CLAUDE.md"), severity: "warn" });
  });

  test("an inline suppression retains the parent CLAUDE.md", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": `<!-- agentfile-linter-disable ${RULE} -->\n@AGENTS.md\n`,
      "app/AGENTS.md": CONTENT,
      "app/CLAUDE.md": "@AGENTS.md\n",
    });
    expect(await summary(root)).toEqual([]);
  });

  test("counts as an enabled rule when it finds nothing", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      ".agentfile-linterrc.json": { categories: { recommended: "off" }, rules: { [RULE]: "warn" } },
    });
    expect(await lint({ cwd: root })).toMatchObject({ fileCount: 1, ruleCount: 1, warningCount: 0 });
  });

  test("is off by default", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": { symlink: "AGENTS.md" } });
    expect(await run(root)).toEqual([]);
  });
});
