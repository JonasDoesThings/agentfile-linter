# agentfile-linter

A Bun + TypeScript CLI that lints AI agent context files (AGENTS.md, CLAUDE.md, GEMINI.md, …).
It compiles to a standalone executable with `bun build --compile`. The CLI and config format are
modeled on oxlint. See [README.md](README.md) for user-facing behavior.

## Commands

- `bun test` runs all tests. Unit tests sit next to the code they test (`src/**/*.test.ts`).
  Cross-cutting integration tests live in `test/`. Tests build throwaway projects in temp
  directories with `makeProject()` from `test/helpers.ts`. `commit()` from the same file
  creates Git history with backdated commits.
- `bun run typecheck` runs `tsc --noEmit`. Unused locals and parameters are errors.
- `bun run lint` runs oxlint with type-aware rules (config: `.oxlintrc.jsonc`). `bun run lint:fix`
  applies the safe autofixes.
- `bun run fmt` formats everything with oxfmt (config: `.oxfmtrc.jsonc`, 120 columns, sorted
  imports). `bun run fmt:check` only checks.
- `bun run check` runs formatting check, lint, typecheck, tests and self-lint. Run it before
  finishing a change.
- `bun run build` builds `dist/agentfile-linter`. `bun run build:all` cross-compiles for every target.
- `bun run build:npm` builds the Node.js CLI at `dist/cli.js`. npm runs it before packing.
- `bun run schema` regenerates `configuration_schema.json`. A test fails if the file is stale.
- `bun run lint:self` lints this repository with itself.

## Conventions

- Imports outside the current directory use the `package.json` subpath aliases `#src/*`,
  `#test/*` and `#package.json`, never `../`. Same-directory imports stay plain relative
  imports.
- Rules must be deterministic and must not touch the network: results depend only on the linted
  files, their Git history and the config, never on the environment or files outside the
  project. The one exception is `agentfile/keep-agents-file-up-to-date`, which compares dates with
  the current time. Prefer false negatives over false positives. When a heuristic is unsure, skip
  the check.

## Layout

- `src/cli.ts`: entry point. Argument parsing is in `src/args.ts`.
- `src/linter.ts`: config setup, file collection (`collectFiles`, also used by
  `--debug files`), per-file rule execution, and the tree pass that runs `checkTree` hooks
  over the discovered directories.
- `src/config.ts`: config loading and validation, plus `RuleResolver`. Settings layer in this
  order: defaults → categories → rules → overrides → CLI flags.
- `src/project.ts`: cached fs access, gitignore, a lazy index of project files, `findUp`,
  `resolveExisting`, `memo`.
- `src/workspace.ts`: package.json and workspace (pnpm/npm/yarn/bun) resolution.
- `src/shell.ts`: tokenizer, command splitting and code-block command extraction.
- `src/frontmatter.ts`: YAML frontmatter extraction and parsing, with source locations for
  syntax errors and duplicate keys.
- `src/git.ts`: Git queries (last commit time, uncommitted changes) with a process limit.
- `src/rules/`: one file per rule, plus its `<rule>.test.ts`. Rules are registered in
  `src/rules/index.ts`.
- `src/runners/`: task runners used by `agentfile/no-missing-script`, one module per ecosystem
  (`node`, `deno`, `make`, `just`, `task`, `python`, `jvm`, `composer`, `cargo`), each with its
  tests. They are registered in `src/runners/index.ts`. Shared helpers (`parseArgs`,
  `notDefined`) are in `src/runners/util.ts`.
- `src/formatters.ts`: output formats (`default`, `stylish`, `json`, `github`, `unix`).

## Adding a rule

1. Create `src/rules/<name>.ts` exporting a `Rule` with `meta` (name `agentfile/<name>`,
   `categories`, `defaultSeverity`, option `schema`), `defaultOptions` and `check()`. Rules
   about things other than context files (such as skill directories) implement `checkTree()`
   instead. It runs once per lint run and reports by path. Rules with no category are off by
   default.
2. Register it in `src/rules/index.ts`.
3. Run `bun run schema`, add `src/rules/<name>.test.ts`, and document the rule in `README.md`.

## Adding a task runner

1. Implement a `TaskRunner` (`id`, `executables`, `check(args, ctx)`) in `src/runners/`. Use
   `ctx.project.findUp` / `resolveExisting` for files and directories, and `notDefined()` for
   consistent messages.
2. Register it in `RUNNERS` in `src/runners/index.ts`. Its `id` then becomes a valid
   `ignoreRunners` value.
3. Run `bun run schema`, add tests next to the runner, and add a row to the runner table in
   `README.md`.
