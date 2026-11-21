import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Project } from "#src/project.ts";
import { makeProject, messages, runRule } from "#test/helpers.ts";

import { parseMakefile } from "./make.ts";

const RULE = "agentfile/no-missing-script";

const MAKEFILE = [
  "BIN := app",
  "CFLAGS ?= -O2",
  "export PATH := $(PWD)/bin:$(PATH)",
  "",
  ".PHONY: build test lint phony-only",
  "",
  "build: deps ## Build it",
  "\tgo build -o $(BIN)",
  "",
  "test lint:",
  "\techo $@",
  "",
  "%.o: %.c",
  "\tcc -c $<",
  "",
  "define HELP",
  "fake: target",
  "endef",
  "",
  "include tools.mk",
  "",
].join("\n");

describe("parseMakefile", () => {
  test("collects targets, .PHONY entries, patterns and includes", () => {
    const root = makeProject({ Makefile: MAKEFILE, "tools.mk": "release:\n\techo\n" });
    const info = parseMakefile(new Project(root), join(root, "Makefile"));
    expect([...info.targets].toSorted()).toEqual(["build", "lint", "phony-only", "release", "test"]);
    expect(info.patterns.some((p) => p.test("main.o"))).toBe(true);
    expect(info.dynamic).toBe(false);
  });

  test("computed targets make the Makefile dynamic", () => {
    const root = makeProject({ Makefile: "$(BIN): main.go\n\tgo build\n" });
    expect(parseMakefile(new Project(root), join(root, "Makefile")).dynamic).toBe(true);
  });
});

describe("make", () => {
  test("reports undefined targets with a suggestion", async () => {
    const root = makeProject({
      Makefile: MAKEFILE,
      "tools.mk": "release:\n\techo\n",
      "AGENTS.md": "`make build test`, `make -j4 release`, `make main.o`, `make CC=clang lint`, `make biuld`\n",
    });
    const diagnostics = await runRule(root, RULE);
    expect(diagnostics.map((d) => [d.message, d.help])).toEqual([
      ["Make target `biuld` is not defined in `Makefile`", "Did you mean `build`?"],
    ]);
  });

  test("recognizes built-in compilation and linking rules with an existing source", async () => {
    const root = makeProject({
      Makefile: "all: src/cli.o\n",
      "src/cli.c": "",
      "src/helper.cpp": "",
      "AGENTS.md": [
        "`make src/cli.o src/helper.o src/cli`",
        "`make src/missing.o`",
        "`make -nr src/cli.o`",
        "`make --no-builtin-rules src/helper.o`",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Make target `src/missing.o` is not defined in `Makefile`",
      "Make target `src/cli.o` is not defined in `Makefile`",
      "Make target `src/helper.o` is not defined in `Makefile`",
    ]);
  });

  test("tracks .SUFFIXES declarations across included files", async () => {
    const root = makeProject({
      Makefile: ".SUFFIXES:\ninclude suffixes.mk\n",
      "suffixes.mk": ".SUFFIXES: .c .o\n",
      "cli.c": "",
      "helper.cpp": "",
      "AGENTS.md": "`make cli.o helper.o`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Make target `helper.o` is not defined in `Makefile`"]);
  });

  test("accepts a built-in file target without a Makefile", async () => {
    const root = makeProject({ "cli.c": "", "AGENTS.md": "`make cli.o`\n" });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("follows -C and -f", async () => {
    const root = makeProject({
      Makefile: "root:\n\techo\n",
      "sub/Makefile": "sub:\n\techo\n",
      "other.mk": "other:\n\techo\n",
      "AGENTS.md": "`make -C sub sub`, `make --directory=sub root`, `make -f other.mk other`, `make -f missing.mk x`\n",
    });
    expect(messages(await runRule(root, RULE))).toEqual([
      "Make target `root` is not defined in `sub/Makefile`",
      "Makefile `missing.mk` does not exist",
    ]);
  });

  test("resolves includes from each invocation directory", async () => {
    const root = makeProject({
      "build/root.mk": "include rules/targets.mk\n",
      "rules/targets.mk": "include extra.mk\n",
      "extra.mk": "lint:\n\techo\n",
      "app/rules/targets.mk": "test:\n\techo\n",
      "AGENTS.md": [
        "`make -f build/root.mk lint`",
        "`make -C app -f ../build/root.mk test`",
        "`make -C app -f ../build/root.mk lint`",
      ].join("\n"),
    });
    expect(messages(await runRule(root, RULE))).toEqual(["Make target `lint` is not defined in `build/root.mk`"]);
  });

  test("does not require a Makefile for help or version flags", async () => {
    const root = makeProject({
      "AGENTS.md": "`make --version`, `make -v`, `make --help` and `make -h`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("searches upward for the Makefile and accepts existing file targets", async () => {
    const root = makeProject({
      Makefile: "build:\n\techo\n",
      "docs/AGENTS.md": "`make build` and `make docs/AGENTS.md`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });

  test("reports a missing Makefile", async () => {
    const root = makeProject({ "AGENTS.md": "`make build`\n" });
    expect(messages(await runRule(root, RULE))).toEqual(["No Makefile found for `make build`"]);
  });

  test("dynamic Makefiles don't report unknown targets", async () => {
    const root = makeProject({
      Makefile: "include $(wildcard *.mk)\nbuild:\n\techo\n",
      "AGENTS.md": "`make anything`\n",
    });
    expect(await runRule(root, RULE)).toEqual([]);
  });
});
