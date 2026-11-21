import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-missing-script";

const JUSTFILE = [
  "set dotenv-load",
  "version := `git describe`",
  "export RUST_LOG := 'info'",
  "alias b := build",
  "mod deploy",
  "import 'extra.just'",
  "",
  "default:",
  "  just --list",
  "",
  "[private]",
  "@build target='debug' *flags:",
  "  cargo build",
  "",
  "test: build",
  "  cargo test",
  "",
  "lint:",
  "  cargo clippy",
  "",
].join("\n");

describe("just", () => {
  test("checks recipes, aliases, imports and modules", async () => {
    const root = makeProject({
      justfile: JUSTFILE,
      "extra.just": "fmt:\n  cargo fmt\n",
      "deploy.just": "prod:\n  echo\n",
      "AGENTS.md": [
        "- `just build release --verbose`",
        "- `just b`",
        "- `just test lint`",
        "- `just fmt`",
        "- `just deploy prod`",
        "- `just deploy::prod`",
        "- `just deploy staging`",
        "- `just lnit`",
        "- `just --list`",
        "- `just`",
        "",
      ].join("\n"),
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      ["Just recipe `staging` is not defined in `deploy.just`", "Available: prod"],
      ["Just recipe `lnit` is not defined in `justfile`", "Did you mean `lint`?"],
    ]);
  });

  test("finds Justfile case-insensitively in parent directories and supports dir/recipe", async () => {
    const root = makeProject({
      Justfile: "build:\n  echo\n",
      "web/justfile": "serve:\n  echo\n",
      "docs/AGENTS.md": "`just build`, `just web/serve`, `just web/build`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Just recipe `build` is not defined in `web/justfile`"]);
  });

  test("reports a missing justfile", async () => {
    const root = makeProject({ "AGENTS.md": "`just build`\n" });
    expect(messages(await runRule(root, RULE))).toEqual(["No justfile found"]);
  });
});
