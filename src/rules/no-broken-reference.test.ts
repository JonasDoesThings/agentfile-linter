import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-broken-reference";

describe("agentfile/no-broken-reference", () => {
  test("checks relative links, images and definitions", async () => {
    const root = makeProject({
      "docs/guide.md": "# Guide\n",
      "img/logo.png": "",
      "AGENTS.md": [
        "[ok](docs/guide.md) [ok2](./docs/) ![logo](img/logo.png)",
        "[missing](docs/missing.md) ![gone](img/gone.png)",
        "[ref][r]",
        "",
        "[r]: ./docs/nope.md",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual([
      "Link target `docs/missing.md` does not exist",
      "Link target `img/gone.png` does not exist",
      "Link target `./docs/nope.md` does not exist",
    ]);
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 11 });
  });

  test("ignores external links, mailto and protocol-relative URLs", async () => {
    const root = makeProject({
      "AGENTS.md": "[a](https://x.dev/a.md) [b](mailto:a@b.c) [c](//cdn.x/y.js) [d](vscode://file/x)\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("checks local anchors with GitHub slugs", async () => {
    const root = makeProject({
      "AGENTS.md": [
        "# Project `agentfile-linter` & Co.",
        "## Setup",
        "## Setup",
        '<a id="custom"></a>',
        "",
        "[a](#project-agentfile-linter--co) [b](#setup-1) [c](#Setup) [d](#custom) [e](#top) [f](#nope)",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Anchor `#nope` does not match any heading in this file"]);
  });

  test("checks anchors in other Markdown files only", async () => {
    const root = makeProject({
      "docs/guide.md": "# Guide\n\n## Install deps\n",
      "src/a.ts": "",
      "AGENTS.md": "[a](docs/guide.md#install-deps) [b](docs/guide.md#nope) [c](src/a.ts#main)\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Anchor `#nope` does not match any heading in `docs/guide.md`",
    ]);
  });

  test("checks line fragments against the length of the target file", async () => {
    const root = makeProject({
      "src/app.ts": "x\n".repeat(50),
      "AGENTS.md": [
        "[a](src/app.ts#L42) [b](src/app.ts#L42-L50) [c](src/app.ts#L10C5-L12C20) [d](src/app.ts#L42-50)",
        "[e](src/app.ts#L51) [f](src/app.ts#L45-L60) [g](src/app.ts#L0) [h](src/app.ts#L50-L42)",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(messages(diagnostics)).toEqual([
      "Line `#L51` is out of range: `src/app.ts` has 50 lines",
      "Line range `#L45-L60` is out of range: `src/app.ts` has 50 lines",
      "Line `#L0` is invalid: line numbers start at 1",
      "Line range `#L50-L42` ends before it starts",
    ]);
    expect(diagnostics[0]).toMatchObject({ line: 2, column: 5 });
  });

  test("counts lines like code hosts do", async () => {
    const root = makeProject({
      "no-eol.txt": "a\nb",
      "crlf.txt": "a\r\nb\r\n",
      "one.txt": "a\n",
      "empty.txt": "",
      "AGENTS.md": [
        "[a](no-eol.txt#L2) [b](no-eol.txt#L3) [c](crlf.txt#L2) [d](crlf.txt#L3)",
        "[e](one.txt#L1) [f](one.txt#L2) [g](empty.txt#L1)",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Line `#L3` is out of range: `no-eol.txt` has 2 lines",
      "Line `#L3` is out of range: `crlf.txt` has 2 lines",
      "Line `#L2` is out of range: `one.txt` has 1 line",
      "Line `#L1` is out of range: `empty.txt` has 0 lines",
    ]);
  });

  test("checks line fragments in Markdown only in the source view (?plain=1)", async () => {
    const root = makeProject({
      "docs/guide.md": "# Guide\n\n## L9\n",
      "AGENTS.md": [
        "[a](docs/guide.md?plain=1#L3) [b](docs/guide.md?plain=1#L9) [c](docs/guide.md#L9) [d](docs/guide.md#L2)",
        "[e](?plain=1#L2) [f](?plain=1#L3) [g](#L2)",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Line `#L9` is out of range: `docs/guide.md` has 3 lines",
      "Anchor `#L2` does not match any heading in `docs/guide.md`",
      "Line `#L3` is out of range: this file has 2 lines",
      "Anchor `#L2` does not match any heading in this file",
    ]);
  });

  test("checks line-like fragments in rendered Markdown as anchors when checkLines is off", async () => {
    const root = makeProject({
      "docs/guide.md": "# Guide\n\n## L9\n",
      "src/a.ts": "",
      "AGENTS.md": "[a](docs/guide.md#L4) [b](docs/guide.md#L9) [c](#L1) [d](src/a.ts#L10) [e](?plain=1#L9)\n",
      ".agentfile-linterrc.json": { rules: { [RULE]: ["error", { checkLines: false }] } },
    });
    expect(messages(await run(root))).toEqual([
      "Anchor `#L4` does not match any heading in `docs/guide.md`",
      "Anchor `#L1` does not match any heading in this file",
    ]);
  });

  test("checks line fragments in a non-Markdown context file itself", async () => {
    const root = makeProject({
      ".cursorrules": "[a](#L1) [b](#L2)\n",
      ".agentfile-linterrc.json": { files: [".cursorrules"] },
    });
    expect(messages(await run(root))).toEqual(["Line `#L2` is out of range: this file has 1 line"]);
  });

  test("skips line fragments on directories, binary, Git LFS and git-ignored files", async () => {
    const root = makeProject({
      ".gitignore": "dist/\n",
      "dist/bundle.js": "x\n",
      "img/logo.png": "\u0089PNG\r\n\u001a\n\u0000\u0000",
      "data/schema.sql": "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a2146\nsize 12345\n",
      "docs/a.md": "",
      "AGENTS.md": "[a](docs/#L5) [b](img/logo.png#L9) [c](dist/bundle.js#L99) [d](data/schema.sql#L120)\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("decodes URL-encoded paths and resolves root-relative links", async () => {
    const root = makeProject({
      "docs/my guide.md": "",
      "packages/a/AGENTS.md": "[a](../../docs/my%20guide.md) [b](/docs/my%20guide.md) [c](/docs/other.md)\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Link target `/docs/other.md` does not exist"]);
  });

  test("checks href/src in inline HTML", async () => {
    const root = makeProject({
      "AGENTS.md": '<img src="logo.png" width="20">\n\n<a href="docs/x.md">x</a>\n',
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Link target `logo.png` does not exist",
      "Link target `docs/x.md` does not exist",
    ]);
  });

  test("decodes escaped filename characters and checks commented-out links", async () => {
    const root = makeProject({
      "docs/Usage #1 & notes.md": "# Install\n",
      "AGENTS.md": [
        "[Guide](docs/Usage%20%231%20%26%20notes.md#install)",
        '<!-- <a href="docs/Usage%20%231%20%26%20notes.md">Notes</a> -->',
        '<!-- <img src="docs/missing%23figure.png"> -->',
      ].join("\n\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Link target `docs/missing%23figure.png` does not exist"]);
  });

  test("skips git-ignored targets and honors options", async () => {
    const root = makeProject({
      ".gitignore": "coverage/\n",
      "src/a.ts": "",
      "AGENTS.md": "[cov](coverage/index.html) [gen](generated/api.md) [anchor](#nope) [line](src/a.ts#L10)\n",
      ".agentfile-linterrc.json": {
        rules: { [RULE]: ["error", { ignore: ["generated/**"], checkAnchors: false, checkLines: false }] },
      },
    });
    expect(await run(root)).toEqual([]);
  });
});
