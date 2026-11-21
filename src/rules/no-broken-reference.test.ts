import { describe, expect, test } from "bun:test";

import { makeProject, messages, run, runRule } from "#test/helpers.ts";

const RULE = "context/no-broken-reference";

describe("context/no-broken-reference", () => {
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
        "# Project `contextlint` & Co.",
        "## Setup",
        "## Setup",
        '<a id="custom"></a>',
        "",
        "[a](#project-contextlint--co) [b](#setup-1) [c](#Setup) [d](#custom) [e](#top) [f](#nope)",
        "",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Anchor `#nope` does not match any heading in this file"]);
  });

  test("checks anchors in other Markdown files only", async () => {
    const root = makeProject({
      "docs/guide.md": "# Guide\n\n## Install deps\n",
      "src/a.ts": "",
      "AGENTS.md": "[a](docs/guide.md#install-deps) [b](docs/guide.md#nope) [c](src/a.ts#L10)\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Anchor `#nope` does not match any heading in `docs/guide.md`",
    ]);
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
      "AGENTS.md": "[cov](coverage/index.html) [gen](generated/api.md) [anchor](#nope)\n",
      ".contextlintrc.json": { rules: { [RULE]: ["error", { ignore: ["generated/**"], checkAnchors: false }] } },
    });
    expect(await run(root)).toEqual([]);
  });
});
