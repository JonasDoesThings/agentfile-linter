# agentfile-linter plugin API

Plugins add custom rules for Markdown context files such as `AGENTS.md`. Load them through `jsPlugins` and enable the rules by name. Rules visit the [mdast](https://github.com/syntax-tree/mdast) tree of each context file.

## Write and run a plugin

With `agentfile-linter` installed as a dev dependency, save this as `lint/agentfile-plugin.mjs`. The `.mjs` extension works in projects that use either CommonJS or ES modules.

```js
/** @type {import("agentfile-linter").Rule<[{ word: string }]>} */
const noTodo = {
  meta: {
    docs: { description: "Disallow TODO notes" },
    messages: { todo: "Resolve the {{ word }} before committing" },
    schema: [{ type: "object", properties: { word: { type: "string" } }, additionalProperties: false }],
    defaultOptions: [{ word: "TODO" }],
  },
  create(context) {
    const [{ word }] = context.options;
    return {
      ":matches(heading, paragraph) > text"(node) {
        if (node.value.includes(word)) context.report({ node, messageId: "todo", data: { word } });
      },
    };
  },
};

/** @satisfies {import("agentfile-linter").Plugin} */
const plugin = {
  meta: { name: "eslint-plugin-team" },
  rules: { "no-todo": noTodo },
};

export default plugin;
```

Add this to `.agentfile-linterrc.json` at the project root.

```json
{
  "jsPlugins": ["./lint/agentfile-plugin.mjs"],
  "rules": {
    "team/no-todo": "error"
  }
}
```

Put `TODO: Review this section.` in `AGENTS.md` and run `npm exec -- agentfile-linter AGENTS.md`. The linter reports `team/no-todo` with the message “Resolve the TODO before committing.” To check for `FIXME` instead, configure the rule as `["error", { "word": "FIXME" }]`.

## Load and enable plugins

A plugin must default-export an object with a `rules` map. A `jsPlugins` entry can be a path relative to the config file, an installed package name, or an object with `name` and `specifier`. For example, with `@eslint/markdown` installed, this config enables one of its rules.

```json
{
  "jsPlugins": [{ "name": "markdown", "specifier": "@eslint/markdown" }],
  "rules": {
    "markdown/no-empty-links": "error"
  }
}
```

The rule ID is `<plugin>/<rule>`. The plugin name comes from the entry's explicit `name`, then the plugin's `meta.name`, then the package name. For the last two, the `eslint-plugin-` and `oxlint-plugin-` prefixes are stripped, so `eslint-plugin-team` becomes `team` and `@scope/eslint-plugin-team` becomes `@scope/team`. The name `agentfile` is reserved for the built-in rules. Use `meta.name` or an explicit entry name for local plugins.

Plugin rules are off by default. Enable them in `rules`, in an `overrides` entry, or with `-W`/`-D`. An override can also load plugins via `jsPlugins`. Once loaded, you can configure their rules anywhere. Category settings and `recommended` apply only to built-in rules. The CLI selector `all` includes plugin rules, and `--rules` lists them. Inline suppressions work with their full rule IDs.

## Types, visitors, and diagnostics

The package provides type-only imports. In TypeScript, use `import type { Plugin, Rule } from "agentfile-linter"` and type the rule as `Rule<[Options]>` for a single options object. The example above uses the same types via JSDoc. See `dist/types/plugin-types.d.ts` in the installed package for the complete type exports. Loading a TypeScript plugin directly requires Node.js 22.18 or newer or the standalone executable.

- `create(context)` runs once per file and returns the visitors. Use a node type such as `link` or an [esquery](https://github.com/estools/esquery) selector as the key. Append `:exit` to run the visitor after its node's children.
- `context` includes `id`, `options`, `settings`, `filename`, `physicalFilename`, `cwd`, `sourceCode`, and `report()`. Configured options are merged over `meta.defaultOptions`. Define `meta.schema` as an array with one JSON schema per option. A rule without a schema accepts no options. Schema keywords such as `$ref` and `format` are ignored.
- `context.sourceCode` exposes `text`, `ast`, `lines`, `lineStartIndices`, `getText()`, `getLoc()`, `getRange()`, `getParent()`, `getAncestors()`, `getLocFromIndex()`, and `getIndexFromLoc()`. Lines and columns start at 1. Character offsets start at 0.
- `context.report()` accepts a literal `message` or a `messageId` from `meta.messages`. Use `data` to fill message placeholders and `node` or `loc` to place the diagnostic.

## Compatibility and extensions

The plugin format follows [ESLint](https://eslint.org/docs/latest/extend/plugins) and [Oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html). The rules in `@eslint/markdown` work unchanged. Oxlint's `createOnce` also works, including the `before` and `after` hooks used by `eslintCompatPlugin` from `@oxlint/plugins`. agentfile-linter calls `createOnce` once per file.

agentfile-linter accepts fix and suggestion fields for compatibility and ignores them. Processors, custom languages, defaults from schemas, and deprecated methods such as `context.getSourceCode()` are unsupported. Use `context.sourceCode` to access the parsed file.

- `report({ help })` adds a hint below the diagnostic. `meta.timeDependent` exempts the rule from unnecessary-suppression reporting. ESLint and Oxlint ignore these fields.
- `context.project` provides cached file system access to the project (its nearest Git root).
- Visitor functions and the `after` hook may return promises. The linter awaits them.
- Use `checkTree(context)` for a rule that checks the discovered directories as a whole. Its optional `collectTreeInputs(context)` hook synchronously returns additional inputs for the rule. Enabled inputs are available as `context.treeInputs` during `checkTree`.

Keep rule results deterministic and based on the project files, Git history, and config.
