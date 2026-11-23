import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import markdown from "@eslint/markdown";

import type { CliRuleFlag } from "#src/config.ts";
import { setup } from "#src/linter.ts";
import { normalizePluginName } from "#src/plugins.ts";
import { type FileSpec, makeProject, messages, rejection, run } from "#test/helpers.ts";

/** A project that can import the packages installed in this repository, such as `@eslint/markdown`. */
const withPackages = (files: Record<string, FileSpec>) =>
  makeProject({ node_modules: { symlink: join(import.meta.dir, "..", "node_modules") }, ...files });

const MARKDOWN = { name: "markdown", specifier: "@eslint/markdown" };

/** A plugin with one rule, named `name`. */
const namedPlugin = (name: string) =>
  `export default { meta: { name: "${name}" }, rules: { rule: { create: () => ({}) } } };`;

/** Turns every rule off, then the given rules on. */
const only = (...rules: string[]): CliRuleFlag[] => [
  { severity: "off", target: "all" },
  ...rules.map((target) => ({ severity: "warn" as const, target })),
];

/** Uses most of the rule API: messages, options, `createOnce`, async visitors, `settings` and a tree rule. */
const LOCAL_PLUGIN = `
export default {
  meta: { name: "eslint-plugin-local" },
  rules: {
    "no-todo": {
      meta: {
        messages: { todo: "Unexpected {{ word }} in a {{ parent }}" },
        schema: [{ type: "object", properties: { words: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
        defaultOptions: [{ words: ["TODO"] }],
      },
      create(context) {
        const { sourceCode } = context;
        const [{ words }] = context.options;
        return {
          text(node) {
            for (const word of words) {
              const index = node.value.indexOf(word);
              if (index === -1) continue;
              const start = sourceCode.getLocFromIndex(sourceCode.getRange(node)[0] + index);
              const end = { line: start.line, column: start.column + word.length };
              const parent = sourceCode.getParent(node).type;
              context.report({ messageId: "todo", data: { word, parent }, loc: { start, end }, help: "Do it now." });
            }
          },
        };
      },
    },
    "heading-count": {
      createOnce(context) {
        let count;
        return {
          before() {
            count = 0;
            return !context.filename.endsWith("CLAUDE.md");
          },
          "heading:exit"() {
            count++;
          },
          async after() {
            await new Promise((resolve) => setTimeout(resolve, 1));
            context.report({ message: count + " headings in " + context.settings.project, loc: { line: 1, column: 1 } });
          },
        };
      },
    },
    "first-node": {
      create(context) {
        return {
          async root(node) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            context.report({ message: context.id + ": " + context.sourceCode.getText(node.children[0]), node: node.children[0] });
          },
        };
      },
    },
    "crash": {
      create() {
        return { heading() { throw new Error("boom"); } };
      },
    },
    "tree": {
      checkTree(ctx) {
        for (const path of ctx.contextFiles) ctx.report(path, { message: "Checked by a tree rule" });
      },
    },
  },
};
`;

describe("ESLint plugins", () => {
  test("every @eslint/markdown rule reports what ESLint reports", async () => {
    // A document that each rule has something to report in; the expected results are ESLint 9's.
    const root = withPackages({
      ".agentfile-linterrc.json": { jsPlugins: [MARKDOWN] },
      "AGENTS.md": [
        "---",
        "title: Demo",
        "---",
        "# Title",
        "",
        "### Skipped level",
        "",
        "# Title",
        "",
        "Visit https://example.com or <b>bold</b> text.",
        "See [nothing]() and [hash](#) and [ok](#title) and [missing](#nope).",
        "![](image.png) ![alt](#)",
        "Use [label][undefined] and [ref] and [](https://x.y).",
        "",
        "[ref]: https://example.com",
        "[unused]: https://example.com",
        "[ref]: https://example.org",
        "[empty]: <>",
        "",
        "* emph * and ** strong **",
        "",
        "```",
        "no language",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 | 3 |",
        "",
        "(reversed)[link] and !(img)[x]",
        "",
        "#No space",
        "",
        "[^1] footnote.",
        "",
        "[^1]: Note.",
        "[^2]: Unused.",
        "",
      ].join("\n"),
    });
    const rules = Object.keys(markdown.rules).map((rule) => `markdown/${rule}`);
    expect(rules).toHaveLength(21);
    const diagnostics = await run(root, { ruleFlags: only(...rules) });
    expect(diagnostics.map((d) => `${d.line}:${d.column} ${d.rule}: ${d.message}`)).toEqual([
      "4:1 markdown/no-multiple-h1: Unexpected additional H1 heading found.",
      "6:1 markdown/heading-increment: Heading level skipped from 1 to 3.",
      '8:1 markdown/no-duplicate-headings: Duplicate heading "Title" found.',
      "8:1 markdown/no-multiple-h1: Unexpected additional H1 heading found.",
      "10:7 markdown/no-bare-urls: Unexpected bare URL. Use autolink (<URL>) or link ([text](URL)) instead.",
      '10:30 markdown/no-html: HTML element "b" is not allowed.',
      "11:5 markdown/no-empty-links: Unexpected empty link found.",
      "11:21 markdown/no-empty-links: Unexpected empty link found.",
      "11:52 markdown/no-missing-link-fragments: Link fragment '#nope' does not reference a heading or anchor in this document.",
      "12:1 markdown/require-alt-text: Alternative text for image is required.",
      "12:16 markdown/no-empty-images: Unexpected empty image found.",
      "13:13 markdown/no-missing-label-refs: Label reference 'undefined' not found.",
      "16:1 markdown/no-unused-definitions: Unexpected unused definition `unused` (label: `unused`) found.",
      "17:1 markdown/no-duplicate-definitions: Unexpected duplicate definition `ref` (label: `ref`) found. First defined at line 15 (label: `ref`).",
      "18:1 markdown/no-empty-definitions: Unexpected empty definition `empty` (label: `empty`) found.",
      "18:1 markdown/no-unused-definitions: Unexpected unused definition `empty` (label: `empty`) found.",
      "20:14 markdown/no-space-in-emphasis: Unexpected space around emphasis marker.",
      "20:22 markdown/no-space-in-emphasis: Unexpected space around emphasis marker.",
      "22:1 markdown/fenced-code-language: Missing code block language.",
      "28:9 markdown/table-column-count: Table column count mismatch (Expected: 2, Actual: 3), extra data starting here will be ignored.",
      "30:1 markdown/no-reversed-media-syntax: Unexpected reversed syntax found. Use [label](URL) syntax instead.",
      "30:12 markdown/no-missing-label-refs: Label reference 'link' not found.",
      "30:23 markdown/no-reversed-media-syntax: Unexpected reversed syntax found. Use [label](URL) syntax instead.",
      "30:29 markdown/no-missing-label-refs: Label reference 'x' not found.",
      "32:1 markdown/no-missing-atx-heading-space: Missing space after hash(es) on ATX style heading.",
      "37:1 markdown/no-unused-definitions: Unexpected unused footnote definition `2` (label: `2`) found.",
    ]);
  });

  test("runs Oxlint plugins written with createOnce and eslintCompatPlugin", async () => {
    const root = withPackages({
      "plugin.js": `
        import { eslintCompatPlugin } from "@oxlint/plugins";
        export default eslintCompatPlugin({
          meta: { name: "oxlint-plugin-links" },
          rules: {
            count: {
              createOnce(context) {
                let links;
                return {
                  before() { links = 0; },
                  link() { links++; },
                  after() { context.report({ message: links + " links in " + context.filename.split("/").pop(), loc: { line: 1, column: 1 } }); },
                };
              },
            },
          },
        });`,
      ".agentfile-linterrc.json": {
        jsPlugins: ["./plugin.js"],
        categories: { recommended: "off" },
        rules: { "links/count": "warn" },
      },
      "AGENTS.md": "[a](https://a.b) and [b](https://c.d)\n",
      "CLAUDE.md": "[c](https://e.f)\n",
    });
    expect(messages(await run(root))).toEqual(["2 links in AGENTS.md", "1 links in CLAUDE.md"]);
  });

  test("plugin rules get options, settings, messages, createOnce hooks and async visitors", async () => {
    const root = makeProject({
      "plugin.js": LOCAL_PLUGIN,
      ".agentfile-linterrc.json": {
        jsPlugins: ["./plugin.js"],
        categories: { recommended: "off" },
        settings: { project: "demo" },
        rules: { "local/no-todo": "warn", "local/heading-count": "error", "local/first-node": "error" },
        overrides: [{ files: ["docs/**"], rules: { "local/no-todo": ["error", { words: ["FIXME"] }] } }],
      },
      "AGENTS.md": "# Title\n\n## TODO later\n\n> FIXME and TODO\n",
      "CLAUDE.md": "# Skipped by `before`\n",
      "docs/AGENTS.md": "TODO and FIXME\n",
    });
    const diagnostics = await run(root);
    expect(diagnostics.map((d) => [d.file, d.line, d.column, d.severity, d.rule, d.message])).toEqual([
      ["AGENTS.md", 1, 1, "error", "local/first-node", "local/first-node: # Title"],
      ["AGENTS.md", 1, 1, "error", "local/heading-count", "2 headings in demo"],
      ["AGENTS.md", 3, 4, "warn", "local/no-todo", "Unexpected TODO in a heading"],
      ["AGENTS.md", 5, 13, "warn", "local/no-todo", "Unexpected TODO in a paragraph"],
      ["CLAUDE.md", 1, 1, "error", "local/first-node", "local/first-node: # Skipped by `before`"],
      ["docs/AGENTS.md", 1, 1, "error", "local/first-node", "local/first-node: TODO and FIXME"],
      ["docs/AGENTS.md", 1, 1, "error", "local/heading-count", "0 headings in demo"],
      ["docs/AGENTS.md", 1, 10, "error", "local/no-todo", "Unexpected FIXME in a paragraph"],
    ]);
    // `help` is an agentfile-linter extension.
    expect(diagnostics.find((d) => d.rule === "local/no-todo")?.help).toBe("Do it now.");
  });

  test("a crashing rule is reported without stopping the other rules", async () => {
    const root = makeProject({
      "plugin.js": LOCAL_PLUGIN,
      ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"] },
      "AGENTS.md": "# TODO\n",
    });
    const diagnostics = await run(root, { ruleFlags: only("local/crash", "local/no-todo") });
    expect(diagnostics.map((d) => [d.rule, d.message.split("\n")[0]])).toEqual([
      ["local/crash", "Rule crashed: Error: boom"],
      ["local/no-todo", "Unexpected TODO in a heading"],
    ]);
  });

  test("a crashed rule reports nothing more, also from pending async visitors", async () => {
    const root = makeProject({
      "plugin.js": `export default { meta: { name: "p" }, rules: { rule: { create: (context) => ({
        async root() { throw new Error("boom"); },
        async link() {
          await new Promise((resolve) => setTimeout(resolve, 1));
          context.report({ message: "After the crash", loc: { line: 1, column: 1 } });
        },
      }) } } };`,
      ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"] },
      "AGENTS.md": "[a](https://example.com)\n",
    });
    const diagnostics = await run(root, { ruleFlags: only("p/rule") });
    expect(diagnostics.map((d) => d.message.split("\n")[0])).toEqual(["Rule crashed: Error: boom"]);
  });

  test("rule options are frozen, as they are shared across files", async () => {
    const root = makeProject({
      "plugin.js": `export default { meta: { name: "p" }, rules: { rule: {
        meta: { schema: [{ type: "object" }], defaultOptions: [{ seen: [] }] },
        create: (context) => ({ root() { context.options[0].seen.push(context.filename); } }),
      } } };`,
      ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"] },
      "AGENTS.md": "",
    });
    const diagnostics = await run(root, { ruleFlags: only("p/rule") });
    expect(diagnostics.map((d) => d.message.split("\n")[0])).toEqual([
      expect.stringMatching(/^Rule crashed: TypeError/),
    ]);
  });

  test("inline directives, -A/-D and `all` cover plugin rules", async () => {
    const root = makeProject({
      "plugin.js": LOCAL_PLUGIN,
      ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"] },
      "AGENTS.md":
        "<!-- agentfile-linter-disable-next-line local/no-todo -->\nTODO\n\nTODO <!-- agentfile-linter-disable-line local/no-tod -->\n",
    });
    // Plugin rules are off until they are enabled.
    expect(await run(root)).toEqual([
      expect.objectContaining({
        line: 4,
        message: "Unknown rule `local/no-tod` in `agentfile-linter-disable-line` directive",
        help: "Did you mean `local/no-todo`?",
      }),
    ]);
    expect(messages(await run(root, { ruleFlags: only("local/no-todo") }))).toEqual([
      "Unexpected TODO in a paragraph",
      "Unknown rule `local/no-tod` in `agentfile-linter-disable-line` directive",
    ]);
    // `all` includes plugin rules (`local/crash` only crashes on headings).
    const all = await run(root, { ruleFlags: [{ severity: "warn", target: "all" }] });
    expect(new Set(all.map((d) => d.rule))).toEqual(
      new Set(["local/no-todo", "local/heading-count", "local/first-node", "local/tree", null]),
    );
  });

  test("categories and `recommended` don't apply to plugin rules", async () => {
    const root = makeProject({
      "plugin.js": `export default { meta: { name: "cat" }, rules: { rule: {
        meta: { docs: { recommended: true, category: "correctness" } },
        create: (context) => ({ root: () => context.report({ message: "Reported", loc: { line: 1, column: 1 } }) }),
      } } };`,
      ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"], categories: { correctness: "error" } },
      "AGENTS.md": "",
    });
    expect(await run(root)).toEqual([]);
    expect(await run(root, { ruleFlags: [{ severity: "warn", target: "recommended" }] })).toEqual([]);
    expect(messages(await run(root, { ruleFlags: [{ severity: "warn", target: "all" }] }))).toEqual(["Reported"]);
  });

  test("plugins can implement the tree hooks", async () => {
    const root = makeProject({
      "plugin.js": LOCAL_PLUGIN,
      ".agentfile-linterrc.json": {
        jsPlugins: ["./plugin.js"],
        categories: { recommended: "off" },
        rules: { "local/tree": "warn" },
      },
      "AGENTS.md": "",
      "pkg/CLAUDE.md": "",
    });
    expect((await run(root)).map((d) => [d.file, d.line, d.column, d.message])).toEqual([
      ["AGENTS.md", 1, 1, "Checked by a tree rule"],
      ["pkg/CLAUDE.md", 1, 1, "Checked by a tree rule"],
    ]);
  });

  test("a crashing `collectTreeInputs` is reported without stopping the other rules", async () => {
    const root = makeProject({
      "plugin.js": `export default { meta: { name: "t" }, rules: {
        throws: { collectTreeInputs() { throw new Error("boom"); }, checkTree(ctx) { ctx.report("AGENTS.md", { message: "unreachable" }); } },
        promise: { async collectTreeInputs() { return []; }, checkTree() {} },
        off: { collectTreeInputs() { throw new Error("off"); }, checkTree() {} },
      } };`,
      ".agentfile-linterrc.json": {
        jsPlugins: ["./plugin.js"],
        categories: { recommended: "off" },
        rules: { "t/throws": "warn", "t/promise": "warn", "agentfile/no-missing-path": "error" },
      },
      "AGENTS.md": "`missing.ts`\n",
      // Named, so that rules that are off also collect inputs.
      "skills/a/SKILL.md": "",
    });
    const expected = [
      ["t/promise", "error", "Rule crashed: TypeError: `collectTreeInputs` must return an array"],
      ["t/throws", "error", "Rule crashed: Error: boom"],
      ["agentfile/no-missing-path", "error", expect.stringContaining("missing.ts")],
    ];
    const runs = await Promise.all([run(root), run(root, { paths: ["AGENTS.md", "skills/a/SKILL.md"] })]);
    for (const diagnostics of runs) {
      expect(diagnostics.map((d) => [d.rule, d.severity, d.message.split("\n")[0]])).toEqual(expected);
    }
  });

  test("plugin paths without an extension and directories are resolved like require()", async () => {
    const root = makeProject({
      "plain.js": namedPlugin("plain"),
      "dir/index.js": namedPlugin("dir"),
      ".agentfile-linterrc.json": { jsPlugins: ["./plain", "./dir"] },
    });
    expect([...(await setup({ cwd: root })).config.registry.rules.keys()]).toEqual(
      expect.arrayContaining(["plain/rule", "dir/rule"]),
    );
  });

  test("TypeScript plugins, jsPlugins in overrides and plugins listed twice", async () => {
    const root = makeProject({
      "plugin.ts": `export default { meta: { name: "ts" }, rules: { hello: { create: (context) => ({ root: () => context.report({ message: "Hello" as string, loc: { line: 1, column: 1 } }) }) } } };`,
      ".agentfile-linterrc.json": {
        jsPlugins: ["./plugin.ts"],
        categories: { recommended: "off" },
        overrides: [{ files: ["docs/**"], jsPlugins: ["./plugin.ts"], rules: { "ts/hello": "error" } }],
      },
      "AGENTS.md": "",
      "docs/AGENTS.md": "",
    });
    expect((await run(root)).map((d) => [d.file, d.rule, d.message])).toEqual([
      ["docs/AGENTS.md", "ts/hello", "Hello"],
    ]);
  });
});

describe("plugin names", () => {
  test.each([
    ["eslint-plugin-foo", "foo"],
    ["oxlint-plugin-foo", "foo"],
    ["@scope/eslint-plugin", "@scope"],
    ["@scope/eslint-plugin-foo", "@scope/foo"],
    ["@eslint/markdown", "@eslint/markdown"],
    ["eslint-plugin", "eslint-plugin"],
    ["foo", "foo"],
  ])("%s → %s", (name, expected) => {
    expect(normalizePluginName(name)).toBe(expected);
  });

  test("an alias, else meta.name, else the package name", async () => {
    const root = makeProject({
      "node_modules/@acme/eslint-plugin/package.json": {
        name: "@acme/eslint-plugin",
        type: "module",
        main: "index.js",
      },
      "node_modules/@acme/eslint-plugin/index.js": "export default { rules: { rule: { create: () => ({}) } } };",
      "named.js": 'export default { meta: { name: "eslint-plugin-named" }, rules: { rule: { create: () => ({}) } } };',
      ".agentfile-linterrc.json": {
        jsPlugins: ["@acme/eslint-plugin", "./named.js", { name: "alias", specifier: "./named.js" }],
      },
    });
    const { registry } = (await setup({ cwd: root })).config;
    expect([...registry.rules.keys()].filter((name) => !name.startsWith("agentfile/"))).toEqual([
      "@acme/rule",
      "named/rule",
      "alias/rule",
    ]);
  });

  test("packages that export only an `import` entry, also through subpath patterns", async () => {
    const root = makeProject({
      "node_modules/eslint-plugin-esm/package.json": {
        name: "eslint-plugin-esm",
        type: "module",
        exports: { ".": { import: "./index.js" }, "./sub/*": { require: "./missing.cjs", import: "./lib/*.js" } },
      },
      "node_modules/eslint-plugin-esm/index.js": namedPlugin("esm"),
      "node_modules/eslint-plugin-esm/lib/other.js": namedPlugin("other"),
      "docs/.agentfile-linterrc.json": { jsPlugins: ["eslint-plugin-esm", "eslint-plugin-esm/sub/other"] },
    });
    const { registry } = (await setup({ cwd: join(root, "docs") })).config;
    expect([...registry.rules.keys()].filter((name) => !name.startsWith("agentfile/"))).toEqual([
      "esm/rule",
      "other/rule",
    ]);
  });
});

/** A project whose plugin rule `p/rule` takes one option that must match `pattern`, set to `option`. */
const patternProject = (pattern: string, option: string) =>
  makeProject({
    "plugin.js": `export default { meta: { name: "p" }, rules: { rule: { meta: { schema: [{ type: "string", pattern: ${JSON.stringify(pattern)} }] }, create: () => ({}) } } };`,
    ".agentfile-linterrc.json": { jsPlugins: ["./plugin.js"], rules: { "p/rule": ["error", option] } },
  });

describe("plugin config errors", () => {
  test.each([
    [{ jsPlugins: ["./missing.js"] }, /Cannot load plugin "\.\/missing\.js"/],
    [{ jsPlugins: ["eslint-plugin-missing"] }, /Cannot load plugin "eslint-plugin-missing"/],
    [{ jsPlugins: [{ specifier: "./a.js" }] }, /"jsPlugins" must be an array of plugin paths/],
    [{ jsPlugins: ["./a.js", "./b.js"] }, /Plugin name "a" is already taken/],
    [{ jsPlugins: ["./builtin.js"] }, /Plugin name "agentfile" is already taken/],
    [{ jsPlugins: ["./nameless.js"] }, /Plugin "\.\/nameless\.js" has no `meta.name`/],
    [{ jsPlugins: ["./not-a-plugin.js"] }, /must export a plugin object with `rules`/],
    [{ jsPlugins: ["./a.js"], rules: { "a/rul": "error" } }, /unknown rule "a\/rul". Did you mean "a\/rule"\?/],
    [{ jsPlugins: ["./a.js"], rules: { "a/rule": ["error", {}] } }, /rule "a\/rule" has no options/],
    [
      { jsPlugins: ["./local.js"], rules: { "local/no-todo": ["error", { words: "x" }] } },
      /invalid options for "local\/no-todo": options.words must be an array/,
    ],
    [{ jsPlugins: ["./local.js"], rules: { "local/no-todo": ["error", {}, {}] } }, /expected at most 1 option, got 2/],
    [
      { jsPlugins: ["./bool-schema.js"], rules: { "b/rule": ["error", [1]] } },
      /invalid options for "b\/rule": options\[0\] can't be checked: the rule's schema is not an object/,
    ],
    [
      { jsPlugins: ["./bool-schema.js"], rules: { "b/rule": ["error", "x"] } },
      /invalid options for "b\/rule": options can't be checked: the rule's schema is not an object/,
    ],
  ])("%j is rejected", async (config, error) => {
    const root = makeProject({
      "a.js": namedPlugin("a"),
      "b.js": namedPlugin("eslint-plugin-a"),
      "builtin.js": namedPlugin("agentfile"),
      "nameless.js": "export default { rules: {} };",
      "not-a-plugin.js": "export const rules = {};",
      "local.js": LOCAL_PLUGIN,
      "bool-schema.js": `export default { meta: { name: "b" }, rules: { rule: { meta: { schema: [{ anyOf: [{ type: "array", items: true }, true] }] }, create: () => ({}) } } };`,
      ".agentfile-linterrc.json": config,
    });
    expect(await rejection(setup({ cwd: root }))).toMatch(error);
  });

  test("option patterns are matched without the `u` flag, as in ESLint", async () => {
    expect((await setup({ cwd: patternProject("^[\\w-.]+$", "a.b") })).config.rules.get("p/rule")).toBeDefined();
    expect(await rejection(setup({ cwd: patternProject("^[\\w-.]+$", "a b") }))).toMatch(
      /options must be a string matching \/\^\[\\w-\.\]\+\$\//,
    );
    expect(await rejection(setup({ cwd: patternProject("(", "a") }))).toMatch(
      /options can't be checked: the rule's schema has an invalid pattern \/\(\//,
    );
  });
});
