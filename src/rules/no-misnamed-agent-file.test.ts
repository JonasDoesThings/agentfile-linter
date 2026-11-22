import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectFiles, lint } from "#src/linter.ts";
import { makeProject, run, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-misnamed-agent-file";
const CONTENT = "# Instructions\n\nUse pnpm.\n";
const SKILL = "---\nname: review\ndescription: Reviews code. Use when asked for a review.\n---\n# Review\n";

const summary = async (root: string, options: Parameters<typeof runRule>[2] = {}) =>
  (await runRule(root, RULE, options)).map((d) => `${d.file}: ${d.message}`);

/** Whether the temp directory's file system ignores case (the macOS and Windows default). */
function isCaseInsensitive(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "agentfile-linter-case-"));
  try {
    writeFileSync(join(dir, "probe"), "");
    return existsSync(join(dir, "PROBE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("agentfile/no-misnamed-agent-file", () => {
  test("differently cased agent files in the project root", async () => {
    const root = makeProject({
      "agents.md": CONTENT,
      "Claude.md": CONTENT,
      "CLAUDE.LOCAL.md": CONTENT,
      "gemini.md": CONTENT,
      "README.md": "# Project\n",
      "CHANGELOG.md": "# Changes\n",
    });
    expect(await summary(root)).toEqual([
      "CLAUDE.LOCAL.md: `CLAUDE.LOCAL.md` must be named exactly `CLAUDE.local.md`",
      "Claude.md: `Claude.md` must be named exactly `CLAUDE.md`",
      "agents.md: `agents.md` must be named exactly `AGENTS.md`",
      "gemini.md: `gemini.md` must be named exactly `GEMINI.md`",
    ]);
  });

  test("reports at the start of the file with a hint about case-only renames", async () => {
    const root = makeProject({ "claude.md": CONTENT });
    expect(await runRule(root, RULE)).toEqual([
      {
        file: "claude.md",
        rule: RULE,
        line: 1,
        column: 1,
        severity: "error",
        message: "`claude.md` must be named exactly `CLAUDE.md`",
        help: expect.stringContaining("rename it with `git mv`"),
      },
    ]);
  });

  test("a wrongly cased extension is reported anywhere", async () => {
    const root = makeProject({
      "AGENTS.MD": CONTENT,
      "docs/guides/CLAUDE.Md": CONTENT,
      "docs/guides/index.md": "# Guides\n",
      "prompts/AGENT.MD": "You are a helpful agent.\n",
    });
    expect(await summary(root)).toEqual([
      "AGENTS.MD: `AGENTS.MD` must be named exactly `AGENTS.md`",
      "docs/guides/CLAUDE.Md: `CLAUDE.Md` must be named exactly `CLAUDE.md`",
      "prompts/AGENT.MD: `AGENT.MD` must be named exactly `AGENT.md`",
    ]);
  });

  test("lowercase names are reported where context files are expected", async () => {
    const root = makeProject({
      ".claude/claude.md": CONTENT,
      "packages/web/package.json": { name: "web" },
      "packages/web/agents.md": CONTENT,
      "crates/core/Cargo.toml": '[package]\nname = "core"\n',
      "crates/core/Claude.md": CONTENT,
      "services/api/AGENTS.md": CONTENT,
      "services/api/claude.md": CONTENT,
    });
    expect(await summary(root)).toEqual([
      ".claude/claude.md: `claude.md` must be named exactly `CLAUDE.md`",
      "crates/core/Claude.md: `Claude.md` must be named exactly `CLAUDE.md`",
      "packages/web/agents.md: `agents.md` must be named exactly `AGENTS.md`",
      "services/api/claude.md: `claude.md` must be named exactly `CLAUDE.md`",
    ]);
  });

  test("lowercase names elsewhere may be documentation pages or prompts", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "docs/claude.md": "# Using Claude\n",
      "docs/integrations/gemini.md": "# Gemini integration\n",
      "src/prompts/agent.md": "You are a helpful agent.\n",
      ".claude/agents.md": CONTENT,
    });
    expect(await summary(root)).toEqual([]);
  });

  test("other lowercase Markdown pages next to the file mark a documentation folder", async () => {
    const root = makeProject({
      "agents.md": "# Agents\n",
      "index.md": "# Home\n",
      "site/package.json": { name: "site" },
      "site/claude.mdx": "# Claude\n",
      "site/claude.md": "# Using Claude\n",
      "api/AGENTS.md": CONTENT,
      "api/gemini.md": "# Gemini\n",
      "api/Setup.markdown": "# Setup\n",
    });
    expect(await summary(root)).toEqual([]);
  });

  test("a lowercase agent.md is reported like the other context file names", async () => {
    const root = makeProject({
      "package.json": { name: "app" },
      "README.md": "# App\n",
      "agent.md": "You are a helpful agent.\n",
      "packages/web/package.json": { name: "web" },
      "packages/web/Agent.md": "You are a helpful agent.\n",
      "services/api/CLAUDE.md": CONTENT,
      "services/api/agent.md": CONTENT,
    });
    expect(await summary(root)).toEqual([
      "agent.md: `agent.md` must be named exactly `AGENT.md`",
      "packages/web/Agent.md: `Agent.md` must be named exactly `AGENT.md`",
      "services/api/agent.md: `agent.md` must be named exactly `AGENT.md`",
    ]);
  });

  test("names matching the configured context file patterns are context files", async () => {
    const root = makeProject({
      ".agentfile-linterrc.json": { files: ["AGENTS.md", "agents.md"] },
      "agents.md": "# Instructions\n\nSee `src/missing.ts`.\n",
      "claude.md": CONTENT,
    });
    expect((await run(root)).map((d) => `${d.rule} ${d.file}`)).toEqual([
      "agentfile/no-missing-path agents.md",
      `${RULE} claude.md`,
    ]);
    expect((await run(root, { paths: ["agents.md", "claude.md"] })).map((d) => `${d.rule} ${d.file}`)).toEqual([
      "agentfile/no-missing-path agents.md",
      `${RULE} claude.md`,
    ]);
  });

  test("SKILL.md spellings are left to no-invalid-skill", async () => {
    const root = makeProject({
      ".claude/skills/deploy/skill.md": SKILL,
      ".claude/skills/review/SKILL.md": SKILL,
      ".claude/skills/review/templates/skill.md": SKILL,
      ".agents/skills/SKILL.MD": SKILL,
      "docs/skill.md": SKILL,
      "notes/SKILL.MD": "# Notes\n",
    });
    expect(await summary(root)).toEqual([]);
    const diagnostics = await run(root, { config: false });
    expect(
      diagnostics.filter((d) => d.message.includes("must be named exactly")).map((d) => `${d.rule} ${d.file}`),
    ).toEqual(["agentfile/no-invalid-skill .claude/skills/deploy/skill.md"]);
  });

  test("a named, wrongly cased SKILL.md is only checked by no-invalid-skill", async () => {
    const root = makeProject({ ".claude/skills/deploy/skill.md": `${SKILL}\nSee \`src/missing.ts\`.\n` });
    const paths = [".claude/skills/deploy/skill.md"];
    expect((await run(root, { config: false, paths })).map((d) => `${d.rule} ${d.message}`)).toEqual([
      "agentfile/no-invalid-skill `skill.md` must be named exactly `SKILL.md`",
    ]);
    const ruleFlags = [{ severity: "off", target: "no-invalid-skill" } as const];
    expect((await run(root, { config: false, paths, ruleFlags })).map((d) => d.message)).toEqual([
      "File skipped because `agentfile/no-invalid-skill` is off for it",
    ]);
  });

  test("misnamed files are listed as linted files", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      ".claude/skills/deploy/skill.md": SKILL,
      "packages/a/package.json": { name: "a" },
      "packages/a/claude.md": CONTENT,
    });
    expect(await collectFiles({ cwd: root, config: false })).toEqual([
      join(root, ".claude/skills/deploy/skill.md"),
      join(root, "AGENTS.md"),
      join(root, "packages/a/claude.md"),
    ]);
  });

  test("symlinks are checked by their own name", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "claude.md": { symlink: "AGENTS.md" } });
    expect(await summary(root)).toEqual(["claude.md: `claude.md` must be named exactly `CLAUDE.md`"]);
  });

  test("symlinked directories are not followed", async () => {
    const root = makeProject({
      "packages/web/package.json": { name: "web" },
      "packages/web/claude.md": CONTENT,
      web: { symlink: "packages/web" },
    });
    expect(await summary(root)).toEqual(["packages/web/claude.md: `claude.md` must be named exactly `CLAUDE.md`"]);
  });

  test("ignored files are skipped unless named on the command line", async () => {
    const root = makeProject({ ".gitignore": "claude.md\n", "claude.md": CONTENT, "docs/claude.md": CONTENT });
    expect(await summary(root)).toEqual([]);
    expect(await summary(root, { paths: ["claude.md", "docs/claude.md"] })).toEqual([
      "claude.md: `claude.md` must be named exactly `CLAUDE.md`",
    ]);
  });

  test("lint scope, overrides and inline directives apply", async () => {
    const root = makeProject({
      ".agentfile-linterrc.json": { overrides: [{ files: ["legacy/**"], rules: { [RULE]: "off" } }] },
      "AGENTS.md": CONTENT,
      "app/package.json": { name: "app" },
      "app/claude.md": CONTENT,
      "legacy/package.json": { name: "legacy" },
      "legacy/claude.md": CONTENT,
      "tool/package.json": { name: "tool" },
      "tool/claude.md": `<!-- agentfile-linter-disable ${RULE} -- read by our own tooling -->\n${CONTENT}`,
    });
    const files = async (paths?: string[]) => (await run(root, { paths })).map((d) => `${d.rule} ${d.file}`);
    expect(await files()).toEqual([`${RULE} app/claude.md`]);
    expect(await files(["legacy", "tool", "AGENTS.md"])).toEqual([]);
  });

  test.skipIf(isCaseInsensitive())("a file next to the correctly named one is something else", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "agents.md": "# Agent catalog\n" });
    expect(await summary(root)).toEqual([]);
  });

  test("correctly named context files count as checked", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": CONTENT });
    const ruleFlags = [{ severity: "off", target: "all" } as const, { severity: "error", target: RULE } as const];
    const result = await lint({ cwd: root, config: false, ruleFlags });
    expect(result).toMatchObject({ fileCount: 2, ruleCount: 1, errorCount: 0 });
  });
});
