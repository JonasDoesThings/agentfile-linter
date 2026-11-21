import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

import { normalizeContent, pointerImports } from "./no-agent-files-drift.ts";

const RULE = "context/no-agent-files-drift";
const CONTENT = "# Agents\n\nUse pnpm.\n\n## Testing\n\nRun tests.\n";

describe("helpers", () => {
  test("normalizeContent ignores BOM, CRLF and trailing whitespace", () => {
    expect(normalizeContent("﻿a\r\nb\r\n\n")).toBe(normalizeContent("a\nb"));
  });

  test("pointerImports detects import-only files", () => {
    expect(pointerImports("@AGENTS.md\n")).toEqual(["AGENTS.md"]);
    expect(pointerImports("<!-- see AGENTS -->\n@./AGENTS.md @docs/extra.md\n")).toEqual([
      "AGENTS.md",
      "docs/extra.md",
    ]);
    expect(pointerImports("# Claude\n@AGENTS.md\n")).toBeNull();
    expect(pointerImports("")).toBeNull();
  });
});

describe("context/no-agent-files-drift", () => {
  test("identical files pass", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": CONTENT.replace(/\n/g, "\r\n"),
      "GEMINI.md": CONTENT,
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("symlinked files pass (and are linted only once)", async () => {
    const root = makeProject({
      "AGENTS.md": `${CONTENT}\n\`missing.ts\`\n`,
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "GEMINI.md": { symlink: "AGENTS.md" },
    });
    const diagnostics = await run(root);
    expect(diagnostics.map((d) => [d.file, d.rule])).toEqual([["AGENTS.md", "context/no-missing-path"]]);
  });

  test("reports the first differing line on the non-canonical file", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": CONTENT.replace("Run tests.", "Run all tests."),
      "GEMINI.md": CONTENT,
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.file, d.line, d.message])).toEqual([
      ["CLAUDE.md", 7, "`CLAUDE.md` has drifted from `AGENTS.md` (first difference at line 7)"],
    ]);
  });

  test("AGENTS.md is canonical; others are compared against it", async () => {
    const root = makeProject({ "CLAUDE.md": "a\n", "GEMINI.md": "b\n", "AGENT.md": "a\n" });
    // AGENT.md comes first in precedence order, so GEMINI.md is the one that drifted.
    expect((await runRule(root, RULE)).map((d) => d.file)).toEqual(["GEMINI.md"]);
  });

  test("import-only pointer files are in sync", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "CLAUDE.md": "@AGENTS.md\n", "GEMINI.md": "@./CLAUDE.md\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("pointer files are reported when allowImports is false", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.md": "@AGENTS.md\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { allowImports: false }] } },
    });
    expect(messages(await run(root))).toEqual([
      "`CLAUDE.md` has drifted from `AGENTS.md` (first difference at line 1)",
    ]);
  });

  test("a pointer to a file with different content is reported", async () => {
    const root = makeProject({ "AGENTS.md": CONTENT, "docs/claude.md": "other\n", "CLAUDE.md": "@docs/claude.md\n" });
    expect(messages(await runRule(root, RULE))).toEqual([
      "`CLAUDE.md` imports `claude.md`, whose content differs from `AGENTS.md`",
    ]);
  });

  test("import cycles are reported", async () => {
    const root = makeProject({ "AGENTS.md": "@CLAUDE.md\n", "CLAUDE.md": "@AGENTS.md\n" });
    expect(messages(await runRule(root, RULE))).toEqual([
      "`AGENTS.md` is part of an import cycle; no file contains the actual instructions",
      "`CLAUDE.md` is part of an import cycle; no file contains the actual instructions",
    ]);
  });

  test("groups are per directory and CLAUDE.local.md is not part of them", async () => {
    const root = makeProject({
      "AGENTS.md": CONTENT,
      "CLAUDE.local.md": "personal\n",
      "packages/a/AGENTS.md": "a\n",
      "packages/a/CLAUDE.md": "b\n",
    });
    expect((await runRule(root, RULE)).map((d) => d.file)).toEqual(["packages/a/CLAUDE.md"]);
  });

  test("custom file list", async () => {
    const root = makeProject({
      "AGENTS.md": "a\n",
      "CLAUDE.md": "b\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { files: ["AGENTS.md", "GEMINI.md"] }] } },
    });
    expect(await run(root, { ruleFlags: [{ severity: "off", target: "no-missing-path" }] })).toEqual([]);
  });
});
