import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collectFiles } from "#src/linter.ts";
import { commit, makeProject, run, runGit, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-claude-local-in-git";
const FILE = "CLAUDE.local.md";

describe(RULE, () => {
  test("reports committed and staged files even after adding a matching .gitignore", async () => {
    const staged = `packages/staged/${FILE}`;
    const root = makeProject({ [FILE]: "", [staged]: "", [`packages/ignored/${FILE}`]: "" });
    commit(root, { paths: [FILE] });
    runGit(root, ["add", "--", staged]);
    writeFileSync(join(root, ".gitignore"), `${FILE}\npackages/\n`);

    expect(await run(root)).toEqual(
      [FILE, staged].map((file) =>
        expect.objectContaining({
          file,
          rule: RULE,
          severity: "error",
          message: `\`${file}\` is tracked by Git`,
          help: `Add \`${FILE}\` to \`.gitignore\` and run \`git rm --cached -- ${file}\` to stop tracking it while keeping your local copy.`,
        }),
      ),
    );
    expect(await collectFiles({ cwd: root })).toEqual([join(root, FILE), join(root, staged)]);
    expect(await runRule(root, RULE, { paths: [staged] })).toEqual([expect.objectContaining({ file: staged })]);
    expect(await runRule(root, RULE, { paths: ["packages/staged"] })).toEqual([
      expect.objectContaining({ file: staged }),
    ]);

    runGit(root, ["rm", "--cached", "--", FILE, staged]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("reports files that only private Git excludes ignore", async () => {
    const privateDir = `private/deep/${FILE}`;
    const root = makeProject({
      [FILE]: "",
      [privateDir]: "",
      ".git/info/exclude": "private/\n",
      ".git/global-ignore": `${FILE}\n`,
    });
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "core.excludesFile", join(root, ".git/global-ignore")]);
    expect(runGit(root, ["check-ignore", "--", FILE, privateDir]).trim().split("\n")).toEqual([FILE, privateDir]);

    expect(await runRule(root, RULE)).toEqual(
      [FILE, privateDir].map((file) =>
        expect.objectContaining({ file, message: `\`${file}\` is only ignored by a private Git exclude` }),
      ),
    );
  });

  test("honors nested .gitignore patterns and negations", async () => {
    const unignored = `nested/${FILE}`;
    const root = makeProject({
      ".gitignore": `${FILE}\n`,
      [FILE]: "",
      "nested/.gitignore": `!/${FILE}\n`,
      [unignored]: "",
      [`nested/deeper/${FILE}`]: "",
    });
    runGit(root, ["init", "-q"]);
    expect(await runRule(root, RULE, { noIgnore: true })).toEqual([expect.objectContaining({ file: unignored })]);
  });

  test("checks selected paths independently of context file patterns", async () => {
    const selected = `packages/a[1]/nested/${FILE}`;
    const explicit = `node_modules/local/${FILE}`;
    const root = makeProject({
      ".agentfile-linterrc.json": { files: ["AGENTS.md"] },
      [FILE]: "",
      [selected]: "",
      [explicit]: "",
      [`packages/b/${FILE}`]: "",
    });
    runGit(root, ["init", "-q"]);
    expect(await run(root, { paths: ["packages/a[1]", explicit] })).toEqual([
      expect.objectContaining({ file: explicit, rule: RULE }),
      expect.objectContaining({ file: selected, rule: RULE }),
    ]);
    expect(await run(root, { ignorePatterns: ["packages/"] })).toEqual([
      expect.objectContaining({ file: FILE, rule: RULE }),
    ]);
  });

  test("works in repositories owned by another user", () => {
    const root = makeProject({ [FILE]: "" });
    runGit(root, ["init", "-q"]);
    runGit(root, ["add", "--", FILE]);
    const cli = join(import.meta.dir, "..", "cli.ts");
    const result = Bun.spawnSync([process.execPath, cli, "-A", "all", "-D", RULE], {
      cwd: root,
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    expect(result.stdout.toString()).toContain(`\`${FILE}\` is tracked by Git`);
    expect(result.exitCode).toBe(1);
  });

  test("ignores Git config from the environment when matching .gitignore", async () => {
    const root = makeProject({ ".gitignore": "claude.local.md\n", [FILE]: "" });
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "core.ignoreCase", "false"]);
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.ignoreCase",
      GIT_CONFIG_VALUE_0: "true",
    });
    try {
      expect(await runRule(root, RULE)).toEqual([expect.objectContaining({ file: FILE })]);
    } finally {
      for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test("reports index entries without a file in the working tree", async () => {
    const deleted = `deleted/${FILE}`;
    const sparse = `sparse dir/${FILE}`;
    const root = makeProject({ [deleted]: "", [sparse]: "" });
    commit(root, { paths: [deleted, sparse] });
    runGit(root, ["update-index", "--skip-worktree", "--", sparse]);
    rmSync(join(root, deleted));
    rmSync(join(root, sparse));

    expect(await runRule(root, RULE)).toEqual([
      expect.objectContaining({
        file: deleted,
        message: `\`${deleted}\` is tracked by Git but not in the working tree`,
        help: `Run \`git rm --cached -- ${deleted}\` to remove it from the index and add \`${FILE}\` to \`.gitignore\`.`,
      }),
      expect.objectContaining({
        file: sparse,
        help: `Run \`git rm --cached --sparse -- '${sparse}'\` to remove it from the index and add \`${FILE}\` to \`.gitignore\`.`,
      }),
    ]);
  });

  test("skips repositories reached through a symlinked directory", async () => {
    const other = makeProject({ [FILE]: "" });
    commit(other, { paths: [FILE] });
    const root = makeProject({ "AGENTS.md": "", linked: { symlink: other } });
    runGit(root, ["init", "-q"]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("skips a submodule whose path is named like a personal file", async () => {
    const root = makeProject({ "AGENTS.md": "", [`${FILE}/`]: "" });
    commit(root, { paths: ["AGENTS.md"] });
    const head = runGit(root, ["rev-parse", "HEAD"]).trim();
    runGit(root, ["update-index", "--add", "--cacheinfo", `160000,${head},${FILE}`]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("skips files outside Git while checking discovered repositories", async () => {
    const nested = `repo/${FILE}`;
    const root = makeProject({ [FILE]: "", [nested]: "" }, { git: false });
    runGit(join(root, "repo"), ["init", "-q"]);
    expect(await runRule(root, RULE)).toEqual([expect.objectContaining({ file: nested })]);
    expect(await runRule(root, RULE, { paths: [FILE] })).toEqual([]);
    runGit(join(root, "repo"), ["add", "--", FILE]);
    expect(await runRule(root, RULE)).toEqual([
      expect.objectContaining({ help: expect.stringContaining(`\`git -C repo rm --cached -- ${FILE}\``) }),
    ]);
  });
});
