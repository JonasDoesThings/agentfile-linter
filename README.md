# contextlint

A linter for AI agent context files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and friends.
Its rules are deterministic, and its CLI and config format are modeled on [oxlint](https://oxc.rs/docs/guide/usage/linter/cli.html).

Context files rot fast. A file gets renamed, a script disappears from `package.json`, or someone
edits `CLAUDE.md` but forgets `AGENTS.md`. The agent then follows stale instructions. contextlint
catches these problems in CI.

```console
$ contextlint .
  × context(no-missing-script): Script `dev` is not defined in `package.json`
   ╭─[AGENTS.md:8:41]
 7 │
 8 │ - `pnpm build` builds everything, `pnpm dev` starts the app.
   ·                                         ───
 9 │ - `pnpm --filter web test` runs the web tests.
   ╰────
  help: `dev` is defined in `apps/web/package.json`

Found 0 warnings and 1 error.
Finished in 14ms on 3 files with 4 rules.
```

## Installation

contextlint is built with [Bun](https://bun.sh) and ships as a single standalone executable.

```sh
bun install
bun run build                       # -> dist/contextlint (current platform)
bun run build:all                   # -> dist/contextlint-<os>-<arch> for every supported target
```

During development you can also run it from source: `bun run src/cli.ts .`

## Usage

```sh
contextlint                         # lint the current directory (same as `contextlint .`)
contextlint packages/web CLAUDE.md  # lint specific directories or files
contextlint -A all -D no-missing-path        # run a single rule
contextlint -W recommended --max-warnings 0  # report everything as warnings, fail on any
contextlint -f github               # GitHub Actions annotations
contextlint --rules                 # list rules
contextlint --init                  # create .contextlintrc.json
contextlint --debug files           # print the files that would be linted, then exit
```

With no config file and no rule flags, every rule in the `recommended` category runs as an `error`.

### Linted files

By default, contextlint finds these files in every directory: `AGENTS.md`, `AGENT.md`,
`CLAUDE.md`, `CLAUDE.local.md` and `GEMINI.md`. `.claude/` and other hidden directories are
included. Discovery skips `node_modules`, `.git` and everything excluded by `.gitignore`. If one
file is a symlink to another, it is linted only once.

Files you name on the command line can have any name and bypass `.gitignore`. A file explicitly
excluded by `ignorePatterns`, `--ignore-pattern`, or the ignore file is skipped with a warning.
Use `--no-ignore` to lint it.

### Options

| Option                   | Description                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `-c, --config <path>`    | Config file. Default: nearest `.contextlintrc.json` / `.contextlintrc.jsonc`, searching upward |
| `--init`                 | Write a starter `.contextlintrc.json`                                                          |
| `-A, --allow <name>`     | Turn a rule, a category or `all` off                                                           |
| `-W, --warn <name>`      | Report a rule, a category or `all` as a warning                                                |
| `-D, --deny <name>`      | Report a rule, a category or `all` as an error                                                 |
| `--ignore-path <path>`   | Ignore file. Default: `.contextlintignore`                                                     |
| `--ignore-pattern <pat>` | Extra gitignore-style pattern; can be repeated                                                 |
| `--no-ignore`            | Disable `.gitignore`, ignore files and ignore patterns                                         |
| `--quiet`                | Report errors only                                                                             |
| `--deny-warnings`        | Exit 1 if there are any warnings                                                               |
| `--max-warnings <n>`     | Exit 1 if there are more than `n` warnings                                                     |
| `-f, --format <fmt>`     | `default`, `stylish`, `json`, `github` or `unix`                                               |
| `--silent`               | Print no diagnostics                                                                           |
| `--print-config`         | Print the effective configuration                                                              |
| `--debug=<options>`      | Debug output, comma-separated. `files`: print the files that would be linted, then exit        |
| `--rules`                | List all rules                                                                                 |

`-A`/`-W`/`-D` are applied left to right, after the config file. A rule name can be written with
or without its `context/` prefix.

**Exit codes:** `0` means no errors. `1` means lint errors were found, or warnings exceeded
`--deny-warnings` / `--max-warnings`. `2` means invalid usage or configuration.

## Configuration

`.contextlintrc.json` (comments and trailing commas are allowed):

```jsonc
{
  "$schema": "./configuration_schema.json",
  // Severity for every rule in a category ("off" | "warn" | "error")
  "categories": { "recommended": "error" },
  "rules": {
    "context/no-missing-path": ["error", { "ignore": ["generated/**"] }],
    "context/no-missing-script": "warn",
  },
  "overrides": [{ "files": ["packages/legacy/**"], "rules": { "no-missing-path": "off" } }],
  "ignorePatterns": ["vendor/"],
  // Replaces the default set of linted files
  "files": ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"],
}
```

Settings are applied in this order: built-in defaults (`recommended` rules as errors), then
`categories`, then `rules`, then matching `overrides`, then CLI flags. Each layer only changes
what it mentions, including individual keys in a rule's options object. The example above keeps
`no-broken-reference` and `no-agent-files-drift` enabled. To opt out entirely, use
`"categories": { "recommended": "off" }` or `-A all`.

Glob patterns (`files`, `overrides[].files`, `ignorePatterns`) are resolved relative to the
config file. A pattern without a `/` matches a file name in any directory.

Severities accept `"off"`/`"allow"`/`0`, `"warn"`/`1` and `"error"`/`"deny"`/`2`.

### Inline suppressions

```text
<!-- contextlint-disable-next-line context/no-missing-path -->
Create `src/new-feature.ts` for the new feature.

`legacy/thing.ts` <!-- contextlint-disable-line -->

<!-- contextlint-disable no-missing-script -- generated section -->

...
<!-- contextlint-enable no-missing-script -->
```

## Rules

| Rule                                                           | Category    | Checks                                                                    |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| [`context/no-missing-path`](#contextno-missing-path)           | recommended | Referenced files and directories exist                                    |
| [`context/no-missing-script`](#contextno-missing-script)       | recommended | Documented scripts and tasks (npm, make, just, uv, maven, cargo, …) exist |
| [`context/no-broken-reference`](#contextno-broken-reference)   | recommended | Relative links, images and `#anchors` resolve                             |
| [`context/no-agent-files-drift`](#contextno-agent-files-drift) | recommended | Agent files in one directory are identical or symlinked                   |

### `context/no-missing-path`

Checks inline code spans that look like paths, plus `@path/to/file.md` imports (the import
syntax of Claude Code and Gemini CLI).

- **What counts as a path:** a span with a known file extension (`src/index.ts`, `package.json`),
  a `./` or `../` prefix, a trailing slash (`docs/`), a dotfile (`.env.example`), a well-known
  file name (`Makefile`, `Dockerfile`, …) or a glob (`src/**/*.test.ts`).
- **Slash paths without an extension** (`src/components`) are checked only when their first
  segment exists. Module names like `react-dom/client` or `origin/main` are therefore ignored.
- **Never treated as paths:** commands, URLs, `node:` specifiers, scoped packages, absolute or
  `~` paths, placeholders (`<name>`, `{id}`, `path/to/…`, `foo.ts`), extension mentions (`.ts`,
  `.d.ts`, `.tscn`), API members (`Bun.sql`, `res.json`) and library names (`Node.js`,
  `postgres.js`).
- **Examples are skipped:** spans introduced by "e.g." / "such as" / "like", spans in a
  paragraph ending with `:` that is followed by a code block ("With the following
  `frontend.tsx`:"), and file names declared on code fences (` ```tsx#frontend.tsx `,
  ` ```ts title="src/app.ts" `).
- **Build outputs are accepted:** a missing `main.js` or `app.css` passes when its source
  (`main.ts`, `app.scss`) exists.
- **Resolution:** a path is looked up from the file's directory, then from each parent directory
  up to the project root (the nearest `.git`). With `allowSuffixMatch`, it also passes if any
  project path ends with it, so `components/Button.tsx` matches
  `apps/web/src/components/Button.tsx`. `./x` paths and `@imports` resolve only relative to the
  file.
- **Not reported:** git-ignored paths (build output, `.env`) and paths under `node_modules`.
  These legitimately don't exist in a fresh checkout.
- Code spans inside links are left to `no-broken-reference`. Fenced code blocks are not checked.

| Option             | Default | Description                                       |
| ------------------ | ------- | ------------------------------------------------- |
| `ignore`           | `[]`    | Glob patterns of referenced paths to skip         |
| `allowSuffixMatch` | `true`  | Accept paths that match the end of a project path |
| `checkImports`     | `true`  | Check `@path` imports                             |

### `context/no-missing-script`

Finds task-runner commands in inline code and in shell code blocks (`sh`, `bash`, `console`,
untagged, …). It then checks that the script, target or task exists where the command would
run.

- **Working directory:** the context file's directory. `cd dir && …` is followed, and so is
  `cd` across the lines of one code block. Relative directories (`cd apps/web`,
  `make -C sub`) are resolved from the file's directory first, then from its parent directories
  up to the project root.
- **Config files are searched upward.** That covers `package.json`, `Makefile`, `justfile` and
  the others in the table below.
- **Nested commands:** commands run through wrappers (`uv run make build`,
  `poetry run task test`) are checked by the runner for the inner command.
- **Prefixes:** `sudo`, `time`, `env`, `corepack` and `VAR=value` are skipped.

| Runner                                          | Commands                                                                | Checks                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm`, `pnpm`, `yarn`, `bun`                    | `npm run x`, `npm test`, `pnpm x`, `yarn workspace w x`, `bun run x`, … | `package.json` scripts in the right workspace (see below)                                                                                                               |
| `deno`                                          | `deno task x`                                                           | `deno.json(c)` tasks or `package.json` scripts; `-r` / `--filter` check every member                                                                                    |
| `make`                                          | `make x`, `make -C dir x`, `make -f file x`                             | Makefile targets, including `.PHONY`, pattern rules and `include`d files                                                                                                |
| `just`                                          | `just x`, `just mod x`, `just mod::x`, `just dir/x`                     | Recipes, aliases, `import`s and `mod`ules                                                                                                                               |
| `task`                                          | `task x`, `task ns:x`                                                   | go-task `Taskfile.yml` tasks, aliases, wildcards and namespaced `includes`. Falls back to taskipy (`[tool.taskipy.tasks]`)                                              |
| `uv`, `poetry`, `pdm`, `rye`, `hatch`, `pipenv` | `uv run x`, `poetry run x`, `hatch run env:x`, …                        | Tool scripts (`[project.scripts]`, `[tool.pdm.scripts]`, Hatch env scripts, Pipfile `[scripts]`, …) or a command provided by a declared dependency or the local `.venv` |
| `poe`                                           | `poe x`, `poetry poe x`                                                 | `[tool.poe.tasks]`                                                                                                                                                      |
| `tox`                                           | `tox -e a,b`                                                            | Environments from `tox.ini`, `tox.toml`, `setup.cfg` or `[tool.tox]`, with generative names (`py{311,312}-django{4,5}`) and factors                                     |
| `nox`                                           | `nox -s a b`                                                            | `@nox.session` functions in `noxfile.py` (or `name=`)                                                                                                                   |
| `maven`                                         | `mvn …`, `./mvnw …`                                                     | Lifecycle phases (`mvn instal` → "did you mean `install`?"), `-pl` modules and `-P` profiles of the reactor                                                             |
| `gradle`                                        | `gradle …`, `./gradlew …`                                               | Project paths in task selectors (`:app:test`, `-x :lib:check`) against `settings.gradle(.kts)`                                                                          |
| `composer`                                      | `composer run-script x`, `composer run x`                               | `composer.json` scripts                                                                                                                                                 |
| `cargo`                                         | `cargo … -p pkg --bin x`                                                | Workspace packages (`-p`) and `--bin` / `--example` / `--test` / `--bench` targets, including auto-discovered ones                                                      |

Each runner stays quiet when it can't decide statically. Examples: computed Makefile targets
(`$(BIN):`), templated Taskfile includes, Gradle composite builds, plugin goals
(`mvn spring-boot:run`) and custom Composer or Cargo subcommands. `task` is a common word, so
it is only checked in projects that use go-task or taskipy.

**npm, pnpm, yarn and bun in detail:**

- **Built-ins are ignored.** That covers built-in commands (`pnpm install`, `bun test`,
  `pnpm deploy`, …) and `--if-present`.
- **Target package:** the nearest `package.json`. Supported overrides:
  `pnpm --filter <sel>`/`-F`, `pnpm -r`, `pnpm -w`, `pnpm -C <dir>`, `npm -w <name|path>`,
  `npm -ws`, `npm --prefix`, `yarn workspace <name>`, `yarn workspaces foreach`, `yarn --cwd`,
  `bun --filter` and `bun --cwd`. Workspaces come from `pnpm-workspace.yaml` or
  `package.json#workspaces`.
- **Filter selectors:** exact names, unscoped names (`web` → `@acme/web`), name globs
  (`@acme/*`), paths (`./apps/web`, `{apps/*}`) and graph selectors (`web...`). Exclusions and
  git ranges are skipped.
- **Binary fallback:** `pnpm`, `yarn` and `bun` also run binaries, so `pnpm tsc` passes when a
  dependency provides `tsc`. `npm run` and `pnpm run` require a script.
- **Bun entry files:** `bun run tool.ts` and `bun tool.ts` also pass when the named file exists in
  the command's working directory.
- **Hints:** the help text says which other package defines the script, or lists the scripts
  that are available.

| Option          | Default | Description                                                                                                                                                                                                                              |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore`        | `[]`    | Glob patterns of script, target or task names to skip                                                                                                                                                                                    |
| `ignoreRunners` | `[]`    | Runners not to check, e.g. `["maven", "gradle"]`. Runner ids: `npm`, `pnpm`, `yarn`, `bun`, `deno`, `make`, `just`, `task`, `poetry`, `uv`, `pdm`, `rye`, `hatch`, `pipenv`, `poe`, `tox`, `nox`, `maven`, `gradle`, `composer`, `cargo` |

### `context/no-broken-reference`

Checks relative Markdown links, images, reference definitions and `href`/`src` in inline HTML.

- `#anchor` must match a heading in the same file, using GitHub-style slugs. Duplicate headings
  get `-1`, `-2` suffixes. Explicit `id`/`name` anchors also count.
- `other.md#anchor` must match a heading in the target Markdown file.
- Root-relative links (`/docs/x.md`) resolve against the project root, as on GitHub.
- External URLs (`https:`, `mailto:`, `//cdn…`) and git-ignored targets are skipped.

| Option         | Default | Description                           |
| -------------- | ------- | ------------------------------------- |
| `checkAnchors` | `true`  | Check `#fragments` against headings   |
| `ignore`       | `[]`    | Glob patterns of link targets to skip |

### `context/no-agent-files-drift`

The agent files in one directory (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `GEMINI.md`) must have
the same effective content. A file passes when it:

- is a symlink to another file in the group,
- has identical text (differences in BOM, line endings and trailing whitespace are ignored), or
- is a pointer whose only content is an import, e.g. `CLAUDE.md` containing `@AGENTS.md`. This
  is allowed by default (`allowImports`).

The first existing file in `files` order is canonical. Every other file is compared with it, and
a mismatch is reported at its first differing line. `CLAUDE.local.md` is personal and is not
part of the group.

| Option         | Default                                               | Description                                          |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `files`        | `["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md"]` | Files that must stay in sync, in order of precedence |
| `allowImports` | `true`                                                | Accept `@OTHER.md` pointer files                     |

## Programmatic API

```ts
import { format, lint } from "contextlint/src/index.ts";

const result = await lint({ cwd: "/path/to/repo", ruleFlags: [{ severity: "warn", target: "all" }] });
console.log(format(result, "stylish", { cwd: "/path/to/repo", color: false }));
```

## Development

```sh
bun test            # all tests (co-located *.test.ts files plus test/ integration tests)
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint (type-aware), `lint:fix` to autofix
bun run fmt         # oxfmt, `fmt:check` to verify
bun run check       # everything above plus tests and self-lint
bun run schema      # regenerate configuration_schema.json after changing rule options
bun run lint:self   # lint this repository's own AGENTS.md
```

Imports outside the current directory use the `package.json` subpath imports `#src/*` and
`#test/*`, e.g. `import { lint } from "#src/linter.ts"`.
