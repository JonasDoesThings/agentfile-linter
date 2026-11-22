import { describe, expect, test } from "bun:test";

import { parseConfig } from "#src/config.ts";
import { lint } from "#src/linter.ts";
import { makeProject, messages, run, runRule } from "#test/helpers.ts";

const RULE = "agentfile/limit-file-size";

const withOptions = (options: Record<string, unknown>) => ({
  ".agentfile-linterrc.json": { categories: { recommended: "off" }, rules: { [RULE]: ["warn", options] } },
});

/** A file of `count` characters: lines of 99 letters and a line break. */
const sized = (count: number) => `${"a".repeat(99)}\n`.repeat(Math.floor(count / 100)) + "a".repeat(count % 100);

describe("agentfile/limit-file-size", () => {
  test("reports files with more than 20,000 characters", async () => {
    const root = makeProject({ "AGENTS.md": sized(20_000), "packages/a/AGENTS.md": sized(20_001) });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.line, d.column, d.message])).toEqual([
      ["packages/a/AGENTS.md", 201, 1, "`AGENTS.md` has 20,001 characters, 1 more than the limit of 20,000"],
    ]);
    expect(diagnostics[0]?.help).toContain("`maxChars`");
  });

  test("is off by default and reports warnings when enabled", async () => {
    const files = { "AGENTS.md": sized(30_000) };
    expect(await run(makeProject(files))).toEqual([]);
    const enabled = makeProject({ ...files, ...withOptions({}) });
    expect((await run(enabled)).map((d) => [d.rule, d.severity])).toEqual([[RULE, "warn"]]);
  });

  test.each([10, "10"])("maxChars: %p", async (maxChars) => {
    const root = makeProject({
      "AGENTS.md": "0123456789",
      "CLAUDE.md": "0123456789\n",
      ...withOptions({ maxChars }),
    });
    expect(messages(await run(root))).toEqual(["`CLAUDE.md` has 11 characters, 1 more than the limit of 10"]);
  });

  test("maxChars must be a non-negative integer", () => {
    for (const value of [1.5, -1, "1.5", "many", true]) {
      expect(() => parseConfig({ rules: { [RULE]: ["warn", { maxChars: value }] } }, null, "/x")).toThrow(
        "options.maxChars must be an integer >= 0 or a string matching /^[0-9]+$/",
      );
    }
  });

  test("counts characters as displayed, not code units, bytes or line endings", async () => {
    // Accented letters (precomposed and decomposed), CJK, emoji with modifiers and ZWJ sequences,
    // flags and CRLF line breaks count once each; a byte order mark doesn't count.
    const text = "﻿é é\r\n日本語\r\n👍🏽 🇦🇹 👨‍👩‍👧\r\n"; // 14 characters, 32 UTF-16 code units
    const root = makeProject({
      "AGENTS.md": text,
      "CLAUDE.md": `${text}!`,
      ...withOptions({ maxChars: 14 }),
    });
    expect(messages(await run(root))).toEqual(["`CLAUDE.md` has 15 characters, 1 more than the limit of 14"]);
  });

  test("reports from the first character past the limit to the end of the content", async () => {
    const root = makeProject({
      "AGENTS.md": "# Title\n\n👍🏽 Use pnpm.\nRun tests.\n\n",
      ...withOptions({ maxChars: 12 }),
    });
    const result = await lint({ cwd: root });
    // `# Title\n\n` is 9 characters and `👍🏽 U` 3 more, so `s` (column 7, after the 4 code units of `👍🏽`) is past the limit.
    expect(result.files.flatMap((f) => f.diagnostics.map((d) => [d.start, d.end]))).toEqual([
      [
        { line: 3, column: 7 },
        { line: 4, column: 11 },
      ],
    ]);
  });

  test("can be suppressed for a file", async () => {
    const root = makeProject({
      "AGENTS.md": `<!-- agentfile-linter-disable agentfile/limit-file-size -- long on purpose -->\n${sized(100)}`,
      ...withOptions({ maxChars: 50 }),
    });
    expect(await run(root)).toEqual([]);
  });
});
