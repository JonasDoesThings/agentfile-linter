import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { format } from "#src/formatters.ts";
import { collectFiles, lint } from "#src/linter.ts";
import { makeProject, run, runRule } from "#test/helpers.ts";

const RULE = "context/no-invalid-skill";

/** A SKILL.md with the given frontmatter lines (`name` defaults to the directory name). */
const skill = (...frontmatter: string[]) => `---\n${frontmatter.join("\n")}\n---\n\n# Skill\n\nDo the thing.\n`;
const valid = (name: string, ...extra: string[]) =>
  skill(`name: ${name}`, "description: Does the thing. Use when the user asks for it.", ...extra);

const summary = async (root: string, options: Parameters<typeof runRule>[2] = {}) =>
  (await runRule(root, RULE, options)).map((d) => `${d.file}:${d.line} ${d.message}`);

describe("context/no-invalid-skill: layout", () => {
  test("valid skills in all known locations pass", async () => {
    const root = makeProject({
      ".claude/skills/review/SKILL.md": valid(
        "review",
        "allowed-tools: [Read, Grep]",
        "argument-hint: [pr-number]",
        "user-invocable: yes",
        "metadata:\n  author: me\n  version: 1.0",
        "version: 2",
      ),
      ".claude/skills/review/references/guide.md": "---\ntitle: Guide\n---\n",
      ".claude/skills/README.md": "# Our skills\n",
      ".claude/skills/scripts-only/run.sh": "echo hi\n",
      ".agents/skills/deploy/SKILL.md": valid("deploy"),
      "packages/web/.github/skills/ui/SKILL.md": valid("ui"),
      ".claude/skills/group/nested/SKILL.md": valid("nested"),
      ".claude/skills/3000/SKILL.md": valid("3000"),
    });
    expect(await summary(root)).toEqual([]);
  });

  test("Markdown files directly in the skills directory", async () => {
    const root = makeProject({
      ".claude/skills/deploy.md": valid("deploy"),
      ".claude/skills/SKILL.md": valid("skills"),
      ".claude/skills/notes.md": "# Notes without frontmatter\n",
      ".claude/skills/README.md": "---\ntitle: Skill catalog\n---\n# Our skills\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.message, d.help])).toEqual([
      [
        ".claude/skills/SKILL.md",
        "`SKILL.md` must be inside a skill directory, not directly in `skills/`",
        "Move it to `skills/<skill-name>/SKILL.md`.",
      ],
      [
        ".claude/skills/deploy.md",
        "`deploy.md` is not loaded as a skill: each skill needs its own directory",
        "Move it to `deploy/SKILL.md`.",
      ],
    ]);
  });

  test("skill directories without a SKILL.md", async () => {
    const root = makeProject({
      ".claude/skills/lower/skill.md": valid("lower"),
      ".claude/skills/plural/Skills.md": valid("plural"),
      ".claude/skills/other/instructions.md": valid("other"),
      ".claude/skills/shared/conventions.md": "# Shared conventions\n",
      ".claude/skills/shared/reference.md": "---\ntitle: Shared reference\n---\n# Reference\n",
      ".claude/skills/group/inner/notes.md": valid("inner"),
    });
    expect(await summary(root)).toEqual([
      ".claude/skills/lower/skill.md:1 `skill.md` must be named exactly `SKILL.md`",
      ".claude/skills/other/instructions.md:1 `other/` has no `SKILL.md`, so it is not loaded as a skill",
      ".claude/skills/plural/Skills.md:1 `Skills.md` must be named exactly `SKILL.md`",
    ]);
  });

  test("skills nested in grouping folders are validated", async () => {
    const root = makeProject({ ".claude/skills/group/inner/SKILL.md": valid("other") });
    expect(await summary(root)).toEqual([
      ".claude/skills/group/inner/SKILL.md:2 Skill name `other` does not match its directory `inner`",
    ]);
  });

  test("skills nested below a misnamed SKILL.md are validated", async () => {
    const root = makeProject({
      ".claude/skills/group/skill.md": "# Group notes\n",
      ".claude/skills/group/deploy/SKILL.md": skill("name: wrong-name"),
    });
    expect(await summary(root)).toEqual([
      ".claude/skills/group/deploy/SKILL.md:1 Frontmatter is missing `description`",
      ".claude/skills/group/deploy/SKILL.md:2 Skill name `wrong-name` does not match its directory `deploy`",
      ".claude/skills/group/skill.md:1 `skill.md` must be named exactly `SKILL.md`",
    ]);
  });

  test("symlinked skill directories are followed, broken links reported", async () => {
    const root = makeProject({
      "shared/skills/linked/SKILL.md": skill("name: linked"),
      ".claude/skills/linked": { symlink: "../../shared/skills/linked" },
      ".claude/skills/gone": { symlink: "../../shared/skills/gone" },
    });
    expect(await summary(root)).toEqual([
      ".claude/skills/gone:1 `gone` is a broken symbolic link",
      ".claude/skills/linked/SKILL.md:1 Frontmatter is missing `description`",
    ]);
  });

  test("a symlinked skills root is checked at its declared location", async () => {
    const root = makeProject({
      "shared/demo/SKILL.md": "# No frontmatter\n",
      ".agents/skills": { symlink: "../shared" },
    });
    expect((await runRule(root, RULE)).map((d) => d.file)).toEqual([".agents/skills/demo/SKILL.md"]);
  });

  test.each([
    ["skills root", { ".claude/skills": { symlink: "../.agents/skills" } }],
    ["skill directory", { ".claude/skills/foo": { symlink: "../../.agents/skills/foo" } }],
    ["SKILL.md", { ".claude/skills/foo/SKILL.md": { symlink: "../../../.agents/skills/foo/SKILL.md" } }],
  ])("a skill shared through a symlinked %s is reported and counted once", async (_, link) => {
    const root = makeProject({ ".agents/skills/foo/SKILL.md": valid("Foo"), ...link });
    const options = { cwd: root, config: false as const };
    const result = await lint({ ...options, ruleFlags: [{ severity: "error", target: RULE }] });
    expect(result).toMatchObject({ fileCount: 1, errorCount: 1 });
    expect(await summary(root)).toEqual([
      ".agents/skills/foo/SKILL.md:2 Skill name `Foo` must contain only lowercase letters, digits and hyphens",
    ]);
    expect(collectFiles(options)).toEqual([join(root, ".agents/skills/foo/SKILL.md")]);
  });

  test("a problem that only one path of a shared skill has stays at that path", async () => {
    const root = makeProject({
      ".agents/skills/foo/SKILL.md": valid("foo"),
      ".claude/skills/bar": { symlink: "../../.agents/skills/foo" },
    });
    const result = await lint({ cwd: root, config: false });
    expect(result).toMatchObject({ fileCount: 1, errorCount: 1 });
    expect(result.files.map(({ filePath }) => filePath)).toEqual([join(root, ".claude/skills/bar/SKILL.md")]);
    expect(await summary(root)).toEqual([
      ".claude/skills/bar/SKILL.md:2 Skill name `foo` does not match its directory `bar`",
    ]);
  });

  test("skills roots below a symlinked directory are checked", async () => {
    const root = makeProject({
      "shared/.claude/skills/demo/SKILL.md": "# No frontmatter\n",
      "app/.claude": { symlink: "../shared/.claude" },
      "app/AGENTS.md": "# Agents\n",
    });
    expect((await runRule(root, RULE, { paths: ["app"] })).map((d) => d.file)).toEqual([
      "app/.claude/skills/demo/SKILL.md",
    ]);
  });

  test("symlinked directories outside the project are not searched for skills roots", async () => {
    const home = makeProject({ ".claude/skills/demo/SKILL.md": "# No frontmatter\n" }, { git: false });
    const root = makeProject({ "AGENTS.md": "# Agents\n", home: { symlink: home } });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("where the project is on disk doesn't make a directory a skills root", async () => {
    const outer = makeProject(
      { ".claude/.git/HEAD": "", ".claude/skills/demo/SKILL.md": "# No frontmatter\n" },
      { git: false },
    );
    expect(await runRule(join(outer, ".claude"), RULE)).toEqual([]);
  });

  test("skill traversal skips symlinks that revisit an ancestor", async () => {
    const root = makeProject({
      ".agents/skills/again": { symlink: "." },
      ".agents/skills/demo/SKILL.md": "# No frontmatter\n",
      ".agents/skills/group/revisit": { symlink: ".." },
      ".agents/skills/group/nested/SKILL.md": valid("nested"),
    });
    const result = await lint({ cwd: root });
    expect(result.fileCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.files.filter(({ diagnostics }) => diagnostics.length).map(({ filePath }) => filePath)).toEqual([
      expect.stringContaining(".agents/skills/demo/SKILL.md"),
    ]);
  });

  test("dangling SKILL.md links are reported inside skills", async () => {
    const root = makeProject({ ".agents/skills/group/demo/SKILL.md": { symlink: "missing.md" } });
    expect(await summary(root)).toEqual([".agents/skills/group/demo/SKILL.md:1 `SKILL.md` is a broken symbolic link"]);
  });

  test("a directory named SKILL.md is a layout error", async () => {
    const root = makeProject({ ".agents/skills/demo/SKILL.md/": "" });
    expect(await summary(root)).toEqual([".agents/skills/demo/SKILL.md:1 `SKILL.md` must be a regular file"]);
  });

  test("ignored skills and other `skills` directories are skipped", async () => {
    const root = makeProject({
      ".gitignore": ".claude/skills/local-*\n",
      ".claude/skills/local-mine/SKILL.md": "no frontmatter\n",
      "src/skills/fireball/SKILL.md": "not an agent skill\n",
      "docs/.claude/skills/x/SKILL.md": "no frontmatter\n",
    });
    expect(await summary(root, { ignorePatterns: ["docs/"] })).toEqual([]);
  });

  test("skills of Claude Code plugins are checked", async () => {
    const root = makeProject({
      "plugins/tools/.claude-plugin/plugin.json": { name: "tools" },
      "plugins/tools/skills/lint/SKILL.md": "no frontmatter\n",
    });
    expect(await summary(root)).toEqual([
      "plugins/tools/skills/lint/SKILL.md:1 `SKILL.md` has no frontmatter with `name` and `description`",
    ]);
  });

  test("a plugin manifest outside the project doesn't make its skills directory a skills root", async () => {
    const outer = makeProject(
      {
        "plugin/.claude-plugin/plugin.json": { name: "tools" },
        "plugin/skills/lint/SKILL.md": "no frontmatter\n",
      },
      { git: false },
    );
    expect(await summary(join(outer, "plugin/skills/lint"))).toEqual([]);
    expect(await summary(join(outer, "plugin"))).toEqual([
      "skills/lint/SKILL.md:1 `SKILL.md` has no frontmatter with `name` and `description`",
    ]);
  });

  test("the `directories` option replaces the default locations", async () => {
    const root = makeProject({
      ".claude/skills/a/SKILL.md": "no frontmatter\n",
      "prompts/skills/b/SKILL.md": "no frontmatter\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { directories: ["prompts/skills"] }] } },
    });
    expect((await run(root)).map((d) => d.file)).toEqual(["prompts/skills/b/SKILL.md"]);
  });

  test("only skills below the linted paths are checked", async () => {
    const root = makeProject({
      ".claude/skills/a/SKILL.md": "no frontmatter\n",
      "packages/web/.claude/skills/b/SKILL.md": "no frontmatter\n",
      "AGENTS.md": "# Agents\n",
    });
    expect((await runRule(root, RULE, { paths: ["packages/web"] })).map((d) => d.file)).toEqual([
      "packages/web/.claude/skills/b/SKILL.md",
    ]);
    expect(await runRule(root, RULE, { paths: ["AGENTS.md"] })).toEqual([]);
  });

  test.each([".agents/skills/group/demo", ".agents/skills/group/demo/SKILL.md"])(
    "validates the selected skill only for %s",
    async (path) => {
      const root = makeProject({
        ".agents/skills/group/demo/SKILL.md": "# No frontmatter\n",
        ".agents/skills/group/other/SKILL.md": "# No frontmatter\n",
      });
      expect((await runRule(root, RULE, { paths: [path] })).map((d) => d.file)).toEqual([
        ".agents/skills/group/demo/SKILL.md",
      ]);
    },
  );

  test("an explicitly named skill bypasses .gitignore", async () => {
    const path = ".agents/skills/demo/SKILL.md";
    const root = makeProject({ ".gitignore": ".agents/\n", [path]: "# No frontmatter\n" });
    expect((await runRule(root, RULE, { paths: [path] })).map((d) => d.file)).toEqual([path]);
  });
});

describe("context/no-invalid-skill: frontmatter", () => {
  test("missing, misplaced and unclosed frontmatter", async () => {
    const root = makeProject({
      ".claude/skills/none/SKILL.md": "# Skill\n",
      ".claude/skills/late/SKILL.md": "\n---\nname: late\ndescription: Late.\n---\n",
      ".claude/skills/open/SKILL.md": "---\nname: open\ndescription: Open.\n\n# Skill\n",
    });
    expect(await summary(root)).toEqual([
      ".claude/skills/late/SKILL.md:2 Frontmatter must start on the first line, or agents treat it as plain text",
      ".claude/skills/none/SKILL.md:1 `SKILL.md` has no frontmatter with `name` and `description`",
      ".claude/skills/open/SKILL.md:1 Frontmatter is not closed",
    ]);
  });

  test("YAML errors are reported at the failing line with a hint", async () => {
    const root = makeProject({
      ".claude/skills/colon/SKILL.md": skill("name: colon", "description: Reviews PRs. Use when: the user asks"),
      ".claude/skills/hint/SKILL.md": skill(
        "name: hint",
        "description: >",
        "  Multi-line: fine",
        "argument-hint: [file] [format]",
      ),
      ".claude/skills/list/SKILL.md": skill("- name: list"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.line, d.message, d.help])).toEqual([
      [
        ".claude/skills/colon/SKILL.md",
        3,
        "Frontmatter is not valid YAML",
        'Quote the value (`key: "…"`): a `: ` inside an unquoted value starts a nested mapping. Claude Code tolerates this in `description`, but other agents\' YAML parsers reject the whole frontmatter.',
      ],
      [
        ".claude/skills/hint/SKILL.md",
        5,
        "Frontmatter is not valid YAML",
        'Quote the value (`key: "…"`): an unquoted value starting with `[` or `{` is read as a YAML list or mapping.',
      ],
      [".claude/skills/list/SKILL.md", 2, "Frontmatter must be a mapping of `key: value` pairs", undefined],
    ]);
  });

  test("field types, duplicates and misspelled fields", async () => {
    const root = makeProject({
      ".claude/skills/fields/SKILL.md": skill(
        "name: fields",
        "description: Does things.",
        "disable-model-invocation: maybe",
        "context: thread",
        "effort: extreme",
        "metadata: none",
        "hooks:",
        "paths: [src/**, 1]",
        "descripton: typo",
        "allowed_tools: Read",
        "name: again",
        // Two edits from `allowed-tools`, one from `disallowed-tools`: the closer field wins.
        "dsallowed-tools: Bash",
      ),
    });
    expect(await summary(root)).toEqual([
      // YAML keeps the last `name`, which doesn't match the directory.
      ".claude/skills/fields/SKILL.md:2 Skill name `again` does not match its directory `fields`",
      ".claude/skills/fields/SKILL.md:4 `disable-model-invocation` must be `true` or `false`",
      ".claude/skills/fields/SKILL.md:5 `context` must be one of `fork`",
      ".claude/skills/fields/SKILL.md:6 `effort` must be one of `low`, `medium`, `high`, `xhigh`, `max`",
      ".claude/skills/fields/SKILL.md:7 `metadata` must be a mapping of `key: value` pairs",
      ".claude/skills/fields/SKILL.md:8 `hooks` has no value",
      ".claude/skills/fields/SKILL.md:10 Unknown frontmatter field `descripton`; did you mean `description`?",
      ".claude/skills/fields/SKILL.md:11 Unknown frontmatter field `allowed_tools`; did you mean `allowed-tools`?",
      ".claude/skills/fields/SKILL.md:12 Duplicate frontmatter field `name`",
      ".claude/skills/fields/SKILL.md:13 Unknown frontmatter field `dsallowed-tools`; did you mean `disallowed-tools`?",
    ]);
  });

  test("duplicate keys are detected in nested and flow mappings", async () => {
    const root = makeProject({
      ".agents/skills/flow/SKILL.md": skill('{name: flow, description: Example, "na\\u006de": flow}'),
      ".agents/skills/nested/SKILL.md": valid("nested", "metadata:\n  author: first\n  author: second"),
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/flow/SKILL.md:2 Duplicate frontmatter field `name`",
      ".agents/skills/nested/SKILL.md:6 Duplicate frontmatter field `author`",
    ]);
  });

  test("custom keys close to short fields or plurals of fields are not misspellings", async () => {
    const custom = ["agents", "models", "colors", "content", "efforts", "argument", "backgrounds", "licence"];
    const root = makeProject({
      ".agents/skills/custom/SKILL.md": valid("custom", ...custom.map((key) => `${key}: x`)),
    });
    expect(await summary(root)).toEqual([]);
  });

  test("unknown fields sharing names with Object methods leave the scan running", async () => {
    const root = makeProject({
      ".agents/skills/a/SKILL.md": valid("a", "valueOf: Custom metadata", "toString: Custom metadata"),
      ".agents/skills/b/SKILL.md": "# No frontmatter\n",
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/b/SKILL.md:1 `SKILL.md` has no frontmatter with `name` and `description`",
    ]);
  });

  test("Agent Skills specification: name and description", async () => {
    const long = "x".repeat(1025);
    const root = makeProject({
      ".claude/skills/missing/SKILL.md": skill("license: MIT"),
      ".claude/skills/upper/SKILL.md": skill("name: Upper", "description: Upper."),
      ".claude/skills/bad--name/SKILL.md": skill("name: bad--name", "description: Hyphens."),
      ".claude/skills/empty/SKILL.md": skill("name: empty", 'description: ""'),
      ".claude/skills/long/SKILL.md": skill("name: long", `description: ${long}`, `compatibility: ${"y".repeat(501)}`),
      [`.claude/skills/${"n".repeat(65)}/SKILL.md`]: skill(`name: ${"n".repeat(65)}`, "description: Long name."),
    });
    expect(await summary(root)).toEqual([
      ".claude/skills/bad--name/SKILL.md:2 Skill name `bad--name` must not start or end with a hyphen or contain `--`",
      ".claude/skills/empty/SKILL.md:3 `description` must not be empty",
      ".claude/skills/long/SKILL.md:3 `description` must be at most 1024 characters long (it has 1025)",
      ".claude/skills/long/SKILL.md:4 `compatibility` must be at most 500 characters long (it has 501)",
      ".claude/skills/missing/SKILL.md:1 Frontmatter is missing `name`",
      ".claude/skills/missing/SKILL.md:1 Frontmatter is missing `description`",
      `.claude/skills/${"n".repeat(65)}/SKILL.md:2 Skill name \`${"n".repeat(65)}\` must be at most 64 characters long`,
      ".claude/skills/upper/SKILL.md:2 Skill name `Upper` must contain only lowercase letters, digits and hyphens",
    ]);
  });

  test("description and compatibility limits count Unicode code points", async () => {
    const root = makeProject({
      ".agents/skills/exact/SKILL.md": skill(
        "name: exact",
        `description: ${"😀".repeat(1024)}`,
        `compatibility: ${"😀".repeat(500)}`,
      ),
      ".agents/skills/over/SKILL.md": skill(
        "name: over",
        `description: ${"😀".repeat(1025)}`,
        `compatibility: ${"😀".repeat(501)}`,
      ),
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/over/SKILL.md:3 `description` must be at most 1024 characters long (it has 1025)",
      ".agents/skills/over/SKILL.md:4 `compatibility` must be at most 500 characters long (it has 501)",
    ]);
  });

  test("`spec: false` only checks what breaks every agent", async () => {
    const root = makeProject({
      ".claude/skills/a/SKILL.md": "# No frontmatter\n",
      ".claude/skills/b/SKILL.md": skill("name: Other Name"),
      ".claude/skills/c/SKILL.md": skill("description: Uses: colons"),
      ".claude/skills/d/SKILL.md": skill("user-invocable: sometimes"),
      ".contextlintrc.json": { rules: { [RULE]: ["error", { spec: false }] } },
    });
    expect((await run(root)).map((d) => `${d.file}:${d.line} ${d.message}`)).toEqual([
      ".claude/skills/c/SKILL.md:2 Frontmatter is not valid YAML",
      ".claude/skills/d/SKILL.md:2 `user-invocable` must be `true` or `false`",
    ]);
  });
});

describe("context/no-invalid-skill: configuration and output", () => {
  test("is recommended and reports errors", async () => {
    const root = makeProject({ ".claude/skills/a/SKILL.md": "# No frontmatter\n" });
    expect((await run(root)).map((d) => [d.rule, d.severity])).toEqual([[RULE, "error"]]);
  });

  test("overrides change severity and options per skill", async () => {
    const root = makeProject({
      ".claude/skills/legacy/SKILL.md": "# No frontmatter\n",
      ".claude/skills/loose/SKILL.md": skill("description: Loose."),
      ".claude/skills/strict/SKILL.md": skill("description: Strict."),
      ".contextlintrc.json": {
        overrides: [
          { files: [".claude/skills/legacy/**"], rules: { [RULE]: "off" } },
          { files: [".claude/skills/loose/**"], rules: { [RULE]: ["warn", { spec: false }] } },
        ],
      },
    });
    expect((await run(root)).map((d) => [d.file, d.severity, d.message])).toEqual([
      [".claude/skills/strict/SKILL.md", "error", "Frontmatter is missing `name`"],
    ]);
  });

  test("a file override can add a custom skill root for just the matching skill", async () => {
    const root = makeProject({
      "custom/demo/SKILL.md": "# No frontmatter\n",
      "custom/other/SKILL.md": "# No frontmatter\n",
      "another/demo/SKILL.md": "# No frontmatter\n",
      ".contextlintrc.json": {
        overrides: [
          { files: ["custom/demo/**"], rules: { [RULE]: ["warn", { directories: ["custom"] }] } },
          { files: ["/another"], rules: { [RULE]: ["error", { directories: ["another"] }] } },
        ],
      },
    });
    expect((await run(root)).map(({ file, severity }) => [file, severity])).toEqual([
      ["another/demo/SKILL.md", "error"],
      ["custom/demo/SKILL.md", "warn"],
    ]);
  });

  test("an override matching only the skills root applies its severity and options to the skills", async () => {
    const override = { files: ["custom"], rules: { [RULE]: ["warn", { directories: ["custom"], spec: false }] } };
    const files = { "custom/a/SKILL.md": "# No frontmatter\n", "custom/b/SKILL.md": "---\nname: b\n" };
    const root = makeProject({ ...files, ".contextlintrc.json": { overrides: [override] } });
    expect((await run(root)).map((d) => [d.file, d.severity, d.message])).toEqual([
      ["custom/b/SKILL.md", "warn", "Frontmatter is not closed"],
    ]);

    const enabled = makeProject({
      ...files,
      ".contextlintrc.json": { rules: { [RULE]: "off" }, overrides: [{ ...override, rules: { [RULE]: "warn" } }] },
    });
    // Same root-only override, now turning on a rule that is off: without `directories`, `custom` is no skills root.
    expect(await run(enabled)).toEqual([]);
    const both = makeProject({ ...files, ".contextlintrc.json": { rules: { [RULE]: "off" }, overrides: [override] } });
    expect((await lint({ cwd: both })).fileCount).toBe(2);
    expect((await run(both)).map((d) => [d.file, d.severity])).toEqual([["custom/b/SKILL.md", "warn"]]);
  });

  test("an override can enable the rule for a file inside a configured skills root", async () => {
    const root = makeProject({
      ".agents/skills/default/SKILL.md": "# No frontmatter\n",
      "custom/demo/SKILL.md": "# No frontmatter\n",
      "custom/other/SKILL.md": "# No frontmatter\n",
      ".contextlintrc.json": {
        rules: { [RULE]: ["off", { directories: ["custom"] }] },
        overrides: [{ files: ["custom/demo/SKILL.md", ".agents/skills/default/SKILL.md"], rules: { [RULE]: "warn" } }],
      },
    });
    expect((await run(root)).map((d) => [d.file, d.severity])).toEqual([["custom/demo/SKILL.md", "warn"]]);
  });

  test("a SKILL.md that is also linted as a context file gets a single result", async () => {
    const root = makeProject({
      ".claude/skills/a/SKILL.md": `${skill("name: a", "description: A.", "context: thread")}\nSee \`missing.ts\`.\n`,
      ".contextlintrc.json": { files: ["SKILL.md"] },
    });
    const result = await lint({ cwd: root });
    expect(result.fileCount).toBe(1);
    expect(result.files.map((f) => [f.filePath.slice(root.length + 1), f.diagnostics.map((d) => d.ruleId)])).toEqual([
      [".claude/skills/a/SKILL.md", [RULE, "context/no-missing-path"]],
    ]);
  });

  test("a SKILL.md named on the command line gets the same checks as a scanned one", async () => {
    const root = makeProject({
      ".claude/skills/foo/SKILL.md": `${skill("name: foo", "description: Foo.", "context: thread")}\nSee \`missing.ts\`.\n`,
    });
    const ids = async (paths?: string[]) =>
      (await lint({ cwd: root, paths })).files.flatMap((f) => f.diagnostics.map((d) => d.ruleId));
    expect(await ids()).toEqual([RULE]);
    expect(await ids([".claude/skills/foo/SKILL.md"])).toEqual([RULE]);
    expect(await ids([".claude/skills/foo"])).toEqual([RULE]);
  });

  test("a named SKILL.md is still a skill where the rule is off, and is reported as skipped", async () => {
    const root = makeProject({
      ".claude/skills/foo/SKILL.md": `${skill("name: foo", "description: Foo.")}\nSee \`missing.ts\`.\n`,
      ".contextlintrc.json": { overrides: [{ files: [".claude/skills/**"], rules: { [RULE]: "off" } }] },
    });
    const paths = [".claude/skills/foo/SKILL.md"];
    const skipped = {
      fileCount: 0,
      warningCount: 1,
      files: [
        {
          filePath: join(root, paths[0] as string),
          diagnostics: [{ ruleId: null, message: `File skipped because \`${RULE}\` is off for it` }],
        },
      ],
    };
    expect(await lint({ cwd: root, paths })).toMatchObject(skipped);
    const ruleFlags = [{ severity: "off" as const, target: RULE }];
    expect(await lint({ cwd: root, paths, ruleFlags, config: false })).toMatchObject(skipped);
    expect(collectFiles({ cwd: root, paths })).toEqual([]);
  });

  test("tree rules count as enabled only when they check something", async () => {
    const root = makeProject({ "AGENTS.md": "# Agents\n" });
    const ruleFlags = [
      { severity: "off" as const, target: "all" },
      { severity: "error" as const, target: RULE },
    ];
    expect(await lint({ cwd: root, ruleFlags })).toMatchObject({ fileCount: 1, ruleCount: 0 });
  });

  test("clean and invalid skills both count toward the total", async () => {
    const root = makeProject({
      ".agents/skills/clean/SKILL.md": valid("clean"),
      ".agents/skills/invalid/SKILL.md": "# No frontmatter\n",
    });
    const result = await lint({ cwd: root, config: false });
    expect(result).toMatchObject({ fileCount: 2, ruleCount: 1, errorCount: 1 });
    expect(result.files.map((file) => file.diagnostics.length)).toEqual([0, 1]);
    const json: unknown = JSON.parse(format(result, "json", { cwd: root, color: false }));
    expect(json).toMatchObject({ number_of_files: 2 });
  });

  test("inline suppressions apply to tree diagnostics and preserve the checked file count", async () => {
    const root = makeProject({
      ".agents/skills/demo/SKILL.md": `<!-- contextlint-disable ${RULE} -->\n# Demo\n`,
      ".agents/skills/other/SKILL.md": "# No frontmatter\n",
    });
    const result = await lint({ cwd: root });
    expect(result).toMatchObject({ fileCount: 2, errorCount: 1 });
    expect(result.files.map(({ diagnostics }) => diagnostics.length)).toEqual([0, 1]);
  });

  test("frontmatter takes suppressions as YAML comments", async () => {
    const root = makeProject({
      ".agents/skills/next/SKILL.md": skill(
        `# contextlint-disable-next-line ${RULE} -- legacy name`,
        "name: Next",
        "description: Does the thing.",
        "effort: extreme",
      ),
      ".agents/skills/same/SKILL.md": skill(`name: Same # contextlint-disable-line ${RULE}`, "description: Does it."),
      // A frontmatter `disable` also covers problems reported on the opening `---`.
      ".agents/skills/block/SKILL.md": skill("# contextlint-disable no-invalid-skill", "name: Block"),
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/next/SKILL.md:5 `effort` must be one of `low`, `medium`, `high`, `xhigh`, `max`",
    ]);
  });

  test("a frontmatter disable after an enable still applies", async () => {
    const root = makeProject({
      ".agents/skills/order/SKILL.md": skill(
        "# contextlint-enable",
        `# contextlint-disable ${RULE}`,
        "name: Bad_Name",
        "description: Does it.",
      ),
    });
    expect(await summary(root)).toEqual([]);
  });

  test("a frontmatter disable covers the opening `---`, but not the lines before it", async () => {
    const root = makeProject({
      ".agents/skills/above/SKILL.md": skill("name: Bad_Name", "description: d", `# contextlint-disable ${RULE}`),
      ".agents/skills/enabled/SKILL.md": skill(
        `# contextlint-disable ${RULE}`,
        "# contextlint-enable",
        "name: Bad_Name",
        `# contextlint-disable ${RULE}`,
        "description: d",
      ),
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/above/SKILL.md:2 Skill name `Bad_Name` must contain only lowercase letters, digits and hyphens",
      ".agents/skills/enabled/SKILL.md:4 Skill name `Bad_Name` must contain only lowercase letters, digits and hyphens",
    ]);
  });

  test("unclosed frontmatter takes suppressions as YAML comments", async () => {
    const root = makeProject({
      ".agents/skills/open/SKILL.md": `---\n# contextlint-disable ${RULE}\nname: open\n\n# Open\n`,
      ".agents/skills/heading/SKILL.md": `---\nname: heading\n\n# contextlint-disable ${RULE}\n`,
    });
    expect(await summary(root)).toEqual([".agents/skills/heading/SKILL.md:1 Frontmatter is not closed"]);
  });

  test("directive text inside YAML strings and block scalars is not a directive", async () => {
    const root = makeProject({
      ".agents/skills/text/SKILL.md": skill(
        "description: |",
        "  Never write # contextlint-disable -- it hides problems",
        'license: "MIT # contextlint-disable"',
        "name: Text",
      ),
    });
    expect(await summary(root)).toEqual([
      ".agents/skills/text/SKILL.md:5 Skill name `Text` must contain only lowercase letters, digits and hyphens",
    ]);
  });

  test("diagnostics show the SKILL.md source", async () => {
    const root = makeProject({ ".claude/skills/a/SKILL.md": skill("name: a", "description: Use when: asked") });
    const output = format(await lint({ cwd: root, config: false }), "default", { cwd: root, color: false });
    expect(output).toContain("× context(no-invalid-skill): Frontmatter is not valid YAML");
    expect(output).toContain("╭─[.claude/skills/a/SKILL.md:3:1]");
    expect(output).toContain(" 3 │ description: Use when: asked");
  });
});
