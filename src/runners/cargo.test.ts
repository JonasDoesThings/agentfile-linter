import { describe, expect, test } from "bun:test";

import { makeProject, messages, runRule } from "#test/helpers.ts";

const RULE = "agentfile/no-missing-script";

const workspace = {
  "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n',
  "crates/cli/Cargo.toml": '[package]\nname = "demo-cli"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n',
  "crates/cli/src/main.rs": "",
  "crates/cli/src/bin/migrate.rs": "",
  "crates/cli/examples/hello.rs": "",
  "crates/cli/tests/integration.rs": "",
  "crates/core/Cargo.toml": '[package]\nname = "demo-core"\n',
  "crates/core/src/lib.rs": "",
  "crates/legacy/Cargo.toml": '[package]\nname = "demo-legacy"\n',
};

describe("cargo", () => {
  test("accepts workspace packages and their targets", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": [
        "- `cargo test -p demo-core`, `cargo +nightly run -p demo-cli --bin demo`",
        "- `cargo run --bin migrate`, `cargo run --example hello`, `cargo test --test integration`",
        "- `cargo build`, `cargo install ripgrep`, `cargo add serde -p demo-core`",
        "",
      ].join("\n"),
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("reports unknown packages and targets", async () => {
    const root = makeProject({
      ...workspace,
      "AGENTS.md": "`cargo test -p demo-legacy`, `cargo run -p demo-cli --bin seed`, `cargo run --example bye`\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      ["Cargo package `demo-legacy` is not defined in the workspace at `Cargo.toml`", "Available: demo-cli, demo-core"],
      ["Binary `seed` is not defined in crate `demo-cli`", "Available: demo, migrate"],
      ["Example `bye` is not defined in crates `demo-cli`, `demo-core`", "Available: hello"],
    ]);
  });

  test("single crates use their own targets", async () => {
    const root = makeProject({
      "Cargo.toml": '[package]\nname = "tool"\n',
      "src/main.rs": "",
      "AGENTS.md": "`cargo run --bin tool` and `cargo run --bin other`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Binary `other` is not defined in crate `tool`"]);
  });
});
