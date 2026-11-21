import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildConfigSchema } from "#src/config-schema.ts";
import { ConfigError, parseConfig, RuleResolver } from "#src/config.ts";
import { setup } from "#src/linter.ts";

import { makeProject, messages, run } from "./helpers.ts";

const enabled = (resolver: RuleResolver, file = "/x/AGENTS.md"): Record<string, string> =>
  Object.fromEntries(resolver.forFile(file).map((r) => [r.rule.meta.name, r.severity]));

const ALL_ERROR: Record<string, string> = {
  "agentfile/no-missing-path": "error",
  "agentfile/no-missing-script": "error",
  "agentfile/no-broken-reference": "error",
  "agentfile/no-agent-files-drift": "error",
  "agentfile/no-invalid-skill": "error",
  "agentfile/no-misnamed-agent-file": "error",
};

describe("rule resolution", () => {
  test("without config every recommended rule is an error", () => {
    expect(enabled(new RuleResolver(parseConfig({}, null, "/x")))).toEqual(ALL_ERROR);
  });

  test("config rules layer on top of the recommended set", () => {
    const config = parseConfig(
      { rules: { "agentfile/no-missing-path": "error", "no-missing-script": "warn" } },
      null,
      "/x",
    );
    expect(enabled(new RuleResolver(config))).toEqual({ ...ALL_ERROR, "agentfile/no-missing-script": "warn" });
  });

  test("categories set the severity of all their rules, rules override categories", () => {
    const config = parseConfig(
      { categories: { recommended: "warn" }, rules: { "no-agent-files-drift": 2, "no-broken-reference": "off" } },
      null,
      "/x",
    );
    expect(enabled(new RuleResolver(config))).toEqual({
      "agentfile/no-missing-path": "warn",
      "agentfile/no-missing-script": "warn",
      "agentfile/no-agent-files-drift": "error",
      "agentfile/no-invalid-skill": "warn",
      "agentfile/no-misnamed-agent-file": "warn",
    });
  });

  test("CLI flags apply left to right after the config", () => {
    const config = parseConfig({ rules: { "no-missing-path": "warn" } }, null, "/x");
    const resolver = new RuleResolver(config, [
      { severity: "off", target: "all" },
      { severity: "error", target: "no-missing-path" },
      { severity: "warn", target: "agentfile/no-missing-script" },
    ]);
    expect(enabled(resolver)).toEqual({ "agentfile/no-missing-path": "error", "agentfile/no-missing-script": "warn" });
    const categories = new RuleResolver(config, [{ severity: "warn", target: "recommended" }]);
    expect(Object.values(enabled(categories))).toEqual(["warn", "warn", "warn", "warn", "warn", "warn"]);
  });

  test("overrides apply to matching files", () => {
    const config = parseConfig(
      {
        overrides: [
          { files: ["packages/legacy/**"], rules: { "no-missing-path": "off" } },
          { files: ["GEMINI.md"], rules: { "no-missing-script": ["warn", { ignore: ["x"] }] } },
        ],
      },
      null,
      "/x",
    );
    const resolver = new RuleResolver(config);
    expect(enabled(resolver, "/x/packages/legacy/AGENTS.md")["agentfile/no-missing-path"]).toBeUndefined();
    expect(enabled(resolver, "/x/packages/other/AGENTS.md")["agentfile/no-missing-path"]).toBe("error");
    const gemini = resolver.forFile("/x/sub/GEMINI.md").find((r) => r.rule.meta.name === "agentfile/no-missing-script");
    expect(gemini).toMatchObject({ severity: "warn", options: { ignore: ["x"] } });
  });

  test("rule options are merged over defaults", () => {
    const config = parseConfig({ rules: { "no-missing-path": ["error", { checkImports: false }] } }, null, "/x");
    const rule = new RuleResolver(config)
      .forFile("/x/AGENTS.md")
      .find((r) => r.rule.meta.name === "agentfile/no-missing-path");
    expect(rule?.options).toEqual({ ignore: [], allowSuffixMatch: true, checkImports: false });
  });

  test("matching overrides inherit options and replace only explicit keys", () => {
    const name = "agentfile/no-missing-path";
    const config = parseConfig(
      {
        rules: { [name]: ["error", { checkImports: false, ignore: ["generated/**"] }] },
        overrides: [
          { files: ["docs/**"], rules: { [name]: ["warn", { allowSuffixMatch: false }] } },
          { files: ["docs/strict/**"], rules: { [name]: ["error", { ignore: [] }] } },
        ],
      },
      null,
      "/x",
    );
    const resolver = new RuleResolver(config);
    const ruleFor = (path: string) => resolver.forFile(path).find((r) => r.rule.meta.name === name);
    expect(ruleFor("/x/docs/strict/AGENTS.md")).toMatchObject({
      severity: "error",
      options: { checkImports: false, allowSuffixMatch: false, ignore: [] },
    });
    expect(ruleFor("/x/docs/AGENTS.md")).toMatchObject({
      severity: "warn",
      options: { checkImports: false, allowSuffixMatch: false, ignore: ["generated/**"] },
    });
    expect(ruleFor("/x/AGENTS.md")?.options).toEqual({
      checkImports: false,
      allowSuffixMatch: true,
      ignore: ["generated/**"],
    });
  });
});

describe("config validation", () => {
  test.each([
    [{ rules: { "no-such-rule": "error" } }, /unknown rule "no-such-rule"/],
    [{ rules: { "no-missing-paht": "error" } }, /Did you mean "agentfile\/no-missing-path"/],
    [{ rules: { "no-missing-path": "loud" } }, /invalid severity "loud"/],
    [{ rules: { "no-missing-path": ["error", { nope: 1 }] } }, /unknown property "nope"/],
    [{ rules: { "no-invalid-skill": ["error", { toString: 1 }] } }, /unknown property "toString"/],
    [{ rules: { "no-missing-path": ["error", { constructor: 1 }] } }, /unknown property "constructor"/],
    [{ rules: { "no-missing-path": ["error", { ignore: "x" }] } }, /options.ignore must be an array/],
    [{ categories: { gemini: "error" } }, /unknown category "gemini"/],
    [{ plugins: [] }, /unknown property "plugins"/],
    [{ overrides: [{ rules: {} }] }, /files must be a non-empty array/],
    [[], /must be a JSON object/],
  ])("%j is rejected", (raw, error) => {
    expect(() => parseConfig(raw, null, "/x")).toThrow(error);
  });

  test("unknown CLI rule targets are rejected", () => {
    expect(() => new RuleResolver(parseConfig({}, null, "/x"), [{ severity: "error", target: "nope" }])).toThrow(
      ConfigError,
    );
  });
});

describe("config files", () => {
  test("auto-discovers .agentfile-linterrc.json (JSONC) in parent directories", async () => {
    const root = makeProject({
      ".agentfile-linterrc.json": '{\n  // comment\n  "rules": { "no-missing-path": "off", },\n}\n',
      "packages/a/AGENTS.md": "`missing.ts`\n",
    });
    const { config } = setup({ cwd: join(root, "packages/a") });
    expect(config.path).toBe(join(root, ".agentfile-linterrc.json"));
    expect(await run(join(root, "packages/a"))).toEqual([]);
  });

  test(".agentfile-linterrc.jsonc is supported, -c selects an explicit file", async () => {
    const root = makeProject({
      ".agentfile-linterrc.jsonc": '{ "rules": { "no-missing-path": "warn" } }',
      "strict.json": '{ "categories": { "recommended": "off" } }',
      "AGENTS.md": "`missing.ts`\n",
    });
    expect((await run(root)).map((d) => d.severity)).toEqual(["warn"]);
    expect(await run(root, { config: "strict.json" })).toEqual([]);
  });

  test("`files` replaces the set of linted files", async () => {
    const root = makeProject({
      ".agentfile-linterrc.json": { files: ["AGENTS.md", ".github/copilot-instructions.md"] },
      "CLAUDE.md": "`missing.ts`\n",
      ".github/copilot-instructions.md": "`missing.ts`\n",
    });
    expect((await run(root)).map((d) => d.file)).toEqual([".github/copilot-instructions.md"]);
  });

  test("configuration_schema.json is up to date (run `bun run schema`)", () => {
    const onDisk = JSON.parse(readFileSync(join(import.meta.dir, "..", "configuration_schema.json"), "utf8"));
    expect(onDisk).toEqual(buildConfigSchema());
  });

  test("messages are stable for invalid JSON", async () => {
    const root = makeProject({ ".agentfile-linterrc.json": "{ nope" });
    expect(() => setup({ cwd: root })).toThrow(/Failed to parse/);
    expect(messages(await run(root, { config: false }))).toEqual([]);
  });
});
