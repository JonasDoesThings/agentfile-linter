import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig } from "#src/config.ts";
import { commit, makeProject, messages, run, runGit, runRule } from "#test/helpers.ts";

const RULE = "agentfile/keep-agents-file-up-to-date";
const CONTENT = "# Agents\n\nUse pnpm.\n";

/** Sets a file's modification time to `days` days ago and returns that date as `YYYY-MM-DD` (UTC). */
function modifiedDaysAgo(root: string, path: string, days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(join(root, path), date, date);
  return date.toISOString().slice(0, 10);
}

// Repository config is cached per directory, so each setting gets its own repository.
const withFileMode = async (line: string) => {
  const root = makeProject({ "AGENTS.md": CONTENT });
  commit(root, { daysAgo: 200 });
  chmodSync(join(root, "AGENTS.md"), 0o755);
  const config = join(root, ".git/config");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^[ \t]*filemode[ \t]*=.*$/im, line));
  return messages(await runRule(root, RULE));
};

const withOptions = (options: Record<string, unknown>) => ({
  ".agentfile-linterrc.json": { categories: { recommended: "off" }, rules: { [RULE]: ["warn", options] } },
});

describe("agentfile/keep-agents-file-up-to-date", () => {
  test("reports files whose last commit is older than 120 days", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "packages/a/AGENTS.md": CONTENT });
    commit(root, { daysAgo: 200, paths: ["AGENTS.md"] });
    commit(root, { daysAgo: 30, paths: ["packages/a/AGENTS.md"] });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.line, d.message])).toEqual([
      [
        "AGENTS.md",
        1,
        expect.stringMatching(/^`AGENTS\.md` has not been updated in 200 days \(last commit: \d{4}-\d\d-\d\d\)$/),
      ],
    ]);
    expect(diagnostics[0]?.help).toContain("120-day limit");
  });

  test("is off by default and reports warnings when enabled", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    commit(root, { daysAgo: 365 });
    expect(await run(root)).toEqual([]);
    const enabled = makeProject({ "AGENTS.md": CONTENT, ...withOptions({}) });
    commit(enabled, { daysAgo: 365 });
    expect((await run(enabled)).map((d) => [d.rule, d.severity])).toEqual([[RULE, "warn"]]);
  });

  test("a merge counts as an update of the files it brings in", async () => {
    const root = makeProject({ "README.md": "# Readme\n" });
    commit(root, { daysAgo: 400 });
    runGit(root, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(root, "AGENTS.md"), CONTENT);
    commit(root, { daysAgo: 300, paths: ["AGENTS.md"] });
    runGit(root, ["checkout", "-q", "-"]);
    runGit(root, ["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("commits to other files don't count as updates", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "src/index.ts": "" });
    commit(root, { daysAgo: 150 });
    appendFileSync(join(root, "src/index.ts"), "export {};\n");
    commit(root, { daysAgo: 1 });
    expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("150 days")]);
  });

  test.each([30, "30"])("warnIfNotUpdatedForDays: %p", async (days) => {
    const root = makeProject({ "AGENTS.md": CONTENT, ...withOptions({ warnIfNotUpdatedForDays: days }) });
    commit(root, { daysAgo: 31 });
    expect(messages(await run(root))).toEqual([expect.stringContaining("31 days")]);
    const fresh = makeProject({ "AGENTS.md": CONTENT, ...withOptions({ warnIfNotUpdatedForDays: days }) });
    commit(fresh, { daysAgo: 30 });
    expect(await run(fresh)).toEqual([]);
  });

  test("warnOnlyForFilesLongerThanChars skips short files", async () => {
    const root = makeProject({
      "AGENTS.md": "# Agents\n\nUse pnpm.\n", // 19 characters
      "GEMINI.md": "# Agents\n\nUse pnpm!!\n", // 20 characters
      "CLAUDE.md": "\n@AGENTS.md\n\n",
      "packages/a/AGENTS.md": "# Agents\n\nUse pnpm!!!\n", // 21 characters
      ...withOptions({ warnOnlyForFilesLongerThanChars: 20 }),
    });
    commit(root, { daysAgo: 300 });
    expect((await run(root)).map((d) => d.file)).toEqual(["packages/a/AGENTS.md"]);
  });

  test("files without Git history are judged by their modification time", async () => {
    const outside = makeProject(
      { "AGENTS.md": CONTENT, "CLAUDE.md": CONTENT, "GEMINI.md": CONTENT, "packages/a/AGENTS.md": CONTENT },
      { git: false },
    );
    const date = modifiedDaysAgo(outside, "AGENTS.md", 200);
    modifiedDaysAgo(outside, "CLAUDE.md", 100);
    const npmEpoch = new Date("1985-10-26T08:15:00Z"); // npm packages reset timestamps to this date
    utimesSync(join(outside, "GEMINI.md"), npmEpoch, npmEpoch);
    utimesSync(join(outside, "packages/a/AGENTS.md"), new Date(1000), new Date(1000)); // Nix store
    const diagnostics = await runRule(outside, RULE);
    expect(messages(diagnostics)).toEqual([`\`AGENTS.md\` has not been updated in 200 days (last modified: ${date})`]);
    expect(diagnostics[0]?.help).toContain("`touch` it");

    const untracked = makeProject({ "AGENTS.md": CONTENT, "src/index.ts": "" });
    commit(untracked, { daysAgo: 1, paths: ["src/index.ts"] });
    modifiedDaysAgo(untracked, "AGENTS.md", 150);
    expect(messages(await runRule(untracked, RULE))).toEqual([expect.stringContaining("150 days (last modified:")]);
  });

  test("modification dates are shown in UTC, independent of the time zone", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT }, { git: false });
    const time = new Date("2025-03-05T02:00:00Z"); // still March 4 in Los Angeles
    utimesSync(join(root, "AGENTS.md"), time, time);
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("(last modified: 2025-03-05)")]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  test("Git history takes precedence over the modification time", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    commit(root, { daysAgo: 10 });
    modifiedDaysAgo(root, "AGENTS.md", 300);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("an untracked file recreated after deletion uses its own modification time", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    commit(root, { daysAgo: 300 });
    runGit(root, ["rm", "AGENTS.md"]);
    commit(root, { daysAgo: 200 });
    writeFileSync(join(root, "AGENTS.md"), CONTENT);
    expect(await runRule(root, RULE)).toEqual([]);
    modifiedDaysAgo(root, "AGENTS.md", 150);
    expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("150 days (last modified:")]);
  });

  test("files with uncommitted changes are skipped", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    commit(root, { daysAgo: 200 });
    appendFileSync(join(root, "AGENTS.md"), "More.\n");
    expect(await runRule(root, RULE)).toEqual([]);
    runGit(root, ["add", "AGENTS.md"]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("a mode change counts as uncommitted unless core.fileMode is false", async () => {
    // A key without a value is true in Git.
    expect(await withFileMode("\tfilemode")).toEqual([]);
    expect(await withFileMode("\tfilemode = false")).toEqual([expect.stringContaining("has not been updated")]);
  });

  test("a staged deletion is skipped if the old file is still in the working tree", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    commit(root, { daysAgo: 200 });
    modifiedDaysAgo(root, "AGENTS.md", 200);
    runGit(root, ["rm", "--cached", "AGENTS.md"]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("staged additions are skipped even without a first commit", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    runGit(root, ["init", "-q"]);
    modifiedDaysAgo(root, "AGENTS.md", 200);
    runGit(root, ["add", "AGENTS.md"]);
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("does not invoke the checkout's filesystem monitor", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      ".git/test-monitor": "#!/bin/sh\ntouch .git/monitor-ran\nexit 1\n",
    });
    commit(root, { daysAgo: 200 });
    const hook = join(root, ".git", "test-monitor");
    chmodSync(hook, 0o755);
    runGit(root, ["config", "core.fsmonitor", hook]);
    expect(await runRule(root, RULE)).toHaveLength(1);
    expect(existsSync(join(root, ".git", "monitor-ran"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("does not run a clean filter on a stat-dirty file", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      ".gitattributes": "AGENTS.md filter=example\n",
      ".git/example-clean": "#!/bin/sh\ntouch .git/filter-ran\ncat\n",
    });
    commit(root, { daysAgo: 200 });
    const filter = join(root, ".git", "example-clean");
    chmodSync(filter, 0o755);
    runGit(root, ["config", "filter.example.clean", filter]);
    modifiedDaysAgo(root, "AGENTS.md", 30);
    expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("200 days (last commit:")]);
    expect(existsSync(join(root, ".git", "filter-ran"))).toBe(false);
  });

  // `none`: Git for Windows sets `core.autocrlf` in the system config, which the rule ignores.
  test.each(["config", "attribute", "none"])("recognizes clean CRLF checkouts from Git %s", async (source) => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "GEMINI.md": CONTENT,
      ".gitattributes": source === "attribute" ? "*.md eol=crlf\nGEMINI.md -text\n" : "GEMINI.md -text\n",
    });
    runGit(root, ["init", "-q"]);
    if (source !== "none") runGit(root, ["config", "core.autocrlf", source === "config" ? "true" : "false"]);
    commit(root, { daysAgo: 200 });
    for (const name of ["AGENTS.md", "GEMINI.md"]) {
      writeFileSync(join(root, name), CONTENT.replaceAll("\n", "\r\n"));
    }
    expect((await runRule(root, RULE)).map(({ file }) => file)).toEqual(["AGENTS.md"]);
  });

  test("reads the repository config again on the next lint run", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "core.fileMode", "true"]);
    commit(root, { daysAgo: 200 });
    chmodSync(join(root, "AGENTS.md"), 0o755);
    expect(await runRule(root, RULE)).toEqual([]);
    runGit(root, ["config", "core.fileMode", "false"]);
    expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("200 days (last commit:")]);
  });

  test("ignores attributes files outside the repository's .gitattributes", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT });
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "core.autocrlf", "true"]);
    commit(root, { daysAgo: 200 });
    // Like a global `~/.config/git/attributes`, which differs between machines.
    writeFileSync(join(root, ".git", "attributes-elsewhere"), "* -text\n");
    runGit(root, ["config", "core.attributesFile", join(root, ".git", "attributes-elsewhere")]);
    writeFileSync(join(root, "AGENTS.md"), CONTENT.replaceAll("\n", "\r\n"));
    expect(messages(await runRule(root, RULE))).toEqual([expect.stringContaining("200 days (last commit:")]);
  });

  test("does not fetch historical objects from a partial clone's remote", async () => {
    const source = makeProject({ "AGENTS.md": CONTENT, "src/index.ts": "" });
    commit(source, { daysAgo: 200 });
    appendFileSync(join(source, "src/index.ts"), "export {};\n");
    commit(source, { daysAgo: 1 });
    runGit(source, ["config", "uploadpack.allowFilter", "true"]);
    const destination = makeProject({}, { git: false });
    runGit(destination, ["clone", "--filter=tree:0", pathToFileURL(source).href, "."]);
    const packDir = join(destination, ".git", "objects", "pack");
    const packs = readdirSync(packDir).toSorted();

    expect(await runRule(destination, RULE)).toEqual([]);
    expect(readdirSync(packDir).toSorted()).toEqual(packs);
  });

  test("a symlinked file is judged by its target's history", async () => {
    const linked = makeProject({ "docs/agents.md": CONTENT, "CLAUDE.md": { symlink: "docs/agents.md" } });
    commit(linked, { daysAgo: 200, paths: ["docs/agents.md"] });
    commit(linked, { daysAgo: 1, paths: ["CLAUDE.md"] });
    expect(messages(await runRule(linked, RULE))).toEqual([
      expect.stringContaining("`CLAUDE.md` has not been updated"),
    ]);
  });

  test("invalid options are rejected", () => {
    for (const value of ["thirty", -1, true]) {
      expect(() =>
        parseConfig({ rules: { [RULE]: ["warn", { warnIfNotUpdatedForDays: value }] } }, null, "/x"),
      ).toThrow("options.warnIfNotUpdatedForDays must be a number >= 0 or a string matching /^[0-9]+$/");
    }
  });
});
