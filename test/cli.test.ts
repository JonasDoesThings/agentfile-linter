import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pkg from "#package.json" with { type: "json" };

import { makeProject } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function cli(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("cli", () => {
  test("`agentfile-linter .` works without config and exits 1 on errors", async () => {
    const root = makeProject({ "AGENTS.md": "# Hi\n\nSee `src/missing.ts`.\n" });
    const { stdout, code } = await cli(root, ".");
    expect(code).toBe(1);
    expect(stdout).toContain("× agentfile(no-missing-path): Path `src/missing.ts` does not exist");
    expect(stdout).toContain("╭─[AGENTS.md:3:6]");
    expect(stdout).toContain("Found 0 warnings and 1 error.");
    expect(stdout).toContain("on 1 file with 5 rules");
  });

  test("exit code: warnings pass unless --deny-warnings / --max-warnings", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts`\n" });
    const codes = await Promise.all([
      cli(root, "-W", "all"),
      cli(root, "-W", "all", "--deny-warnings"),
      cli(root, "-W", "all", "--max-warnings", "0"),
      // One warning is not more than one.
      cli(root, "-W", "all", "--max-warnings=1"),
    ]).then((results) => results.map((r) => r.code));
    expect(codes).toEqual([0, 1, 1, 0]);
  });

  test("--quiet hides warnings; --silent hides everything", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts` `pnpm dev`\n" });
    const [quiet, silent] = await Promise.all([
      cli(root, "-W", "no-missing-path", "--quiet", "-f", "unix"),
      cli(root, "--silent"),
    ]);
    expect(quiet.stdout).not.toContain("missing.ts");
    expect(quiet.stdout).toContain("no-missing-script");
    expect(silent.stdout).toBe("");
    expect(silent.code).toBe(1);
  });

  test("json, stylish, github and unix formats, for errors and info diagnostics", async () => {
    // Line 1 is an info diagnostic (unknown rule in a directive), line 2 an error.
    const root = makeProject({
      "AGENTS.md": "<!-- agentfile-linter-disable-next-line no-mising-path -->\n`missing.ts`\n",
    });
    const info = "Unknown rule `no-mising-path` in `agentfile-linter-disable-next-line` directive";
    const [json, stylish, github, unix] = await Promise.all(
      ["json", "stylish", "github", "unix"].map((format) => cli(root, "-f", format)),
    );
    expect(JSON.parse(json?.stdout ?? "")).toMatchObject({
      errors: 1,
      warnings: 0,
      number_of_files: 1,
      diagnostics: [
        { severity: "info", rule: null, message: info },
        {
          code: "agentfile(no-missing-path)",
          rule: "agentfile/no-missing-path",
          severity: "error",
          filename: "AGENTS.md",
          start: { line: 2, column: 2 },
        },
      ],
    });
    expect(stylish?.stdout).toContain(`  1:41  info   ${info}`);
    expect(stylish?.stdout).toMatch(/  2:2 +error +Path `missing.ts` does not exist +agentfile\/no-missing-path/);
    expect(github?.stdout).toContain(
      "::notice file=AGENTS.md,line=1,endLine=1,col=41,endColumn=55,title=agentfile-linter::",
    );
    expect(github?.stdout).toContain(
      "::error file=AGENTS.md,line=2,endLine=2,col=2,endColumn=12,title=agentfile/no-missing-path::",
    );
    expect(unix?.stdout).toBe(
      `AGENTS.md:1:41: ${info} [Info/agentfile-linter]\n` +
        "AGENTS.md:2:2: Path `missing.ts` does not exist [Error/agentfile/no-missing-path]\n\n1 problem\n",
    );
  });

  test("unknown rules in directives are printed as info and don't fail the run", async () => {
    const root = makeProject({ "AGENTS.md": "<!-- agentfile-linter-disable-next-line no-mising-path -->\nHi\n" });
    const message = "Unknown rule `no-mising-path` in `agentfile-linter-disable-next-line` directive";
    const [result, stylish, unix] = await Promise.all([
      cli(root, "--deny-warnings"),
      cli(root, "-f", "stylish"),
      cli(root, "-f", "unix"),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ℹ agentfile-linter: ${message}`);
    expect(result.stdout).toContain("╭─[AGENTS.md:1:41]");
    expect(result.stdout).toContain("help: Did you mean `agentfile/no-missing-path`?");
    expect(result.stdout).toContain("Found 0 warnings and 0 errors.");
    // Info diagnostics are no problems: these formats print no summary for them.
    expect(stylish.stdout).toBe(`AGENTS.md\n  1:41  info  ${message}\n\n`);
    expect(unix.stdout).toBe(`AGENTS.md:1:41: ${message} [Info/agentfile-linter]\n`);
  });

  test("usage and config errors exit 2", async () => {
    const root = makeProject({ ".agentfile-linterrc.json": '{ "rules": { "nope": "error" } }' });
    const [config, option, format, debug] = await Promise.all([
      cli(root),
      cli(root, "--nope"),
      cli(root, "-f", "xml", "-c", "x.json"),
      cli(root, "--debug", "files,unknown"),
    ]);
    expect(config).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown rule "nope"') });
    expect(option.code).toBe(2);
    expect(format.code).toBe(2);
    expect(debug).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("'unknown' is not a known debug option (available: files, timings)"),
    });
  });

  test("--init, --print-config, --version, --help", async () => {
    const root = makeProject({});
    expect((await cli(root, "--init")).code).toBe(0);
    const config = Bun.JSONC.parse(readFileSync(join(root, ".agentfile-linterrc.json"), "utf8"));
    expect(config).toEqual({ categories: { recommended: "error" }, rules: {}, ignorePatterns: [] });

    const [printed, version, help] = await Promise.all([
      cli(root, "--print-config", "-A", "no-missing-script"),
      cli(root, "-V"),
      cli(root, "-h"),
    ]);
    const description = JSON.parse(printed.stdout);
    expect(description.configFile).toBe(".agentfile-linterrc.json");
    expect(description.rules["agentfile/no-missing-script"]).toBe("off");
    expect(version.stdout).toBe(`agentfile-linter ${pkg.version}\n`);
    expect(help.stdout).toContain("Usage: agentfile-linter [OPTIONS] [PATH]...");
  });

  test("--rules lists the rules that load and reports config problems below them", async () => {
    const root = makeProject({
      "ok.js": 'export default { meta: { name: "ok" }, rules: { rule: { create: () => ({}) } } };',
      "name.js": "export default { meta: { name: 42 }, rules: { rule: { create: () => ({}) } } };",
      "meta.js": 'export default { meta: "x", rules: { rule: { create: () => ({}) } } };',
      ".agentfile-linterrc.json": {
        jsPlugins: ["./ok.js", "./missing.js", "./name.js", "./meta.js"],
        rules: { "missing/rule": "error" },
      },
    });
    const typo = makeProject({ ".agentfile-linterrc.json": { rules: { "no-missing-paht": "error" } } });
    const [listed, fixed, noConfig] = await Promise.all([
      cli(root, "--rules"),
      cli(typo, "--rules"),
      cli(typo, "--rules", "-c", "nope.json"),
    ]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/^ok\/rule +- +off/m);
    expect(listed.stdout).toMatch(/^agentfile\/no-agent-files-drift +suspicious +error +AGENTS\.md/m);
    expect(listed.stdout).toMatch(/^agentfile\/keep-agents-file-up-to-date +pedantic +off +Context files/m);
    expect(listed.stderr).toMatch(/^\nagentfile-linter: /);
    expect(listed.stderr).toMatch(/Cannot load plugin "\.\/missing\.js": .*\. Its rules are not listed\.\n/);
    expect(listed.stderr).toContain('Plugin "./name.js" has an invalid `meta.name`: expected a string.');
    expect(listed.stderr).toContain('Plugin "./meta.js" has an invalid `meta`: expected an object');
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toMatch(/^agentfile\/no-missing-path /m);
    expect(fixed.stderr).toContain('unknown rule "no-missing-paht". Did you mean "agentfile/no-missing-path"?');
    expect(noConfig.stderr).toContain("Config file not found: nope.json");
  });

  test("--init preserves an existing JSONC config", async () => {
    const root = makeProject({
      ".agentfile-linterrc.jsonc": { categories: { recommended: "off" } },
      "AGENTS.md": "`missing.ts`\n",
    });
    expect(await cli(root, "--init")).toMatchObject({ code: 2, stderr: ".agentfile-linterrc.jsonc already exists.\n" });
    expect(existsSync(join(root, ".agentfile-linterrc.json"))).toBe(false);
    expect((await cli(root)).code).toBe(0);
  });

  test("--debug files lists the files that would be linted, then exits", async () => {
    const root = makeProject({
      ".gitignore": "ignored/\n",
      "AGENTS.md": "`missing.ts`\n",
      "CLAUDE.md": { symlink: "AGENTS.md" },
      "packages/a/GEMINI.md": "",
      "ignored/AGENTS.md": "",
    });
    const [all, inline, noIgnore] = await Promise.all([
      cli(root, "--debug", "files"),
      cli(root, "--debug=files", "packages"),
      cli(root, "--debug", "files", "--no-ignore"),
    ]);
    expect(all.code).toBe(0);
    expect(all.stdout).toBe("AGENTS.md\npackages/a/GEMINI.md\n");
    expect(inline.stdout).toBe("packages/a/GEMINI.md\n");
    expect(noIgnore.stdout).toBe("AGENTS.md\nignored/AGENTS.md\npackages/a/GEMINI.md\n");
  });

  test("--debug files lists selected skills and exits successfully without linting", async () => {
    const root = makeProject({
      "custom/a/SKILL.md": "# Missing frontmatter\n",
      "custom/b/SKILL.md": "# Missing frontmatter\n",
      ".gitignore": "custom/b/\n",
      ".agentfile-linterrc.json": {
        overrides: [{ files: ["custom/**"], rules: { "no-invalid-skill": ["error", { directories: ["custom"] }] } }],
      },
    });
    const [linted, listed, off] = await Promise.all([
      cli(root),
      cli(root, "--debug=files,timings"),
      cli(root, "--debug=files", "-A", "no-invalid-skill"),
    ]);
    expect(linted.code).toBe(1);
    expect(listed).toMatchObject({ code: 0, stdout: "custom/a/SKILL.md\n", stderr: "" });
    expect(off.stdout).toBe("");
  });

  test("--debug timings counts invoked callbacks and writes the sorted table to stderr", async () => {
    const root = makeProject({
      "AGENTS.md": "# Heading\n\n`missing.ts`\n",
      "CLAUDE.md": "# Skipped heading\n",
      "timed.mjs": `export default { meta: { name: "timed" }, rules: {
        file: {
          createOnce(context) {
            return {
              before() { return !context.filename.endsWith("CLAUDE.md"); },
              heading() {},
              "heading:exit"() {},
              "heading[depth=2]"() {},
              async after() { await Bun.sleep(25); },
            };
          },
        },
        tree: {
          collectTreeInputs() { return []; },
          async checkTree() { await Bun.sleep(25); },
        },
        crash: {
          create() { return { heading() { throw new Error("timed crash"); } }; },
        },
      } };`,
      ".agentfile-linterrc.json": {
        categories: { recommended: "off" },
        jsPlugins: ["./timed.mjs"],
        rules: { "no-missing-path": "error", "timed/file": "error", "timed/tree": "error", "timed/crash": "error" },
      },
    });
    const { code, stdout, stderr } = await cli(root, "--debug", "timings", "--format=json");
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ diagnostics: expect.any(Array) });
    expect(stdout).toContain("timed crash");
    expect(stderr).toMatch(/^Rule timings:\nRule +Time \(ms\) +Relative +Calls +Source\n/);
    const rows = stderr
      .trimEnd()
      .split("\n")
      .slice(3)
      .map((line) => {
        const [rule, time, , calls, source] = line.split(/\s+/);
        return { rule, time: Number(time), calls: Number(calls), source };
      });
    expect(rows.map((row) => row.time)).toEqual(rows.map((row) => row.time).toSorted((a, b) => b - a));
    expect(rows).toEqual(
      expect.arrayContaining([
        { rule: "timed/file", time: expect.any(Number), calls: 7, source: "plugin" },
        { rule: "timed/tree", time: expect.any(Number), calls: 2, source: "plugin" },
        { rule: "timed/crash", time: expect.any(Number), calls: 4, source: "plugin" },
        { rule: "agentfile/no-missing-path", time: expect.any(Number), calls: expect.any(Number), source: "built-in" },
      ]),
    );
    for (const rule of ["timed/file", "timed/tree"]) {
      expect(rows.find((row) => row.rule === rule)?.time).toBeGreaterThan(10);
    }
  });

  test("prints a hint when no context files are found", async () => {
    const root = makeProject({ "README.md": "" });
    const { stderr, code } = await cli(root);
    expect(code).toBe(0);
    expect(stderr).toContain("No context files found");
  });

  test("counts a clean skill when invoked inside its directory", async () => {
    const files = {
      ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: Demonstrates linting.\n---\n# Demo\n",
    };
    const root = makeProject(files);
    // Without Git, the project is the skill directory: the skills directory above it is outside.
    const outside = makeProject(files, { git: false });
    const [inside, noGit] = await Promise.all([
      cli(join(root, ".agents", "skills", "demo")),
      cli(join(outside, ".agents", "skills", "demo")),
    ]);
    expect(inside.code).toBe(0);
    expect(inside.stdout).toContain("on 1 file with 1 rule");
    expect(inside.stderr).toBe("");
    expect(noGit.stdout).toContain("on 0 files");
  });

  test("warns when an explicitly named file is skipped by a configured ignore", async () => {
    const root = makeProject({
      ".agentfile-linterrc.json": { ignorePatterns: ["generated/"] },
      ".gitignore": "local/\n",
      "generated/AGENTS.md": "`missing.ts`\n",
      "local/AGENTS.md": "# Local instructions\n",
    });
    const file = join("generated", "AGENTS.md");
    const [{ stdout, stderr, code }, denied, noIgnore, gitignored] = await Promise.all([
      cli(root, file),
      cli(root, "-f", "json", "--deny-warnings", file),
      cli(root, "--no-ignore", file),
      cli(root, "--debug", "files", join("local", "AGENTS.md")),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("File skipped because it matches an ignore pattern");
    expect(stdout).toContain("Found 1 warning and 0 errors.");
    expect(stdout).not.toContain("missing.ts");
    expect(stderr).toBe("");

    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout)).toMatchObject({
      number_of_files: 0,
      warnings: 1,
      diagnostics: [{ filename: file, severity: "warning", rule: null }],
    });
    expect(noIgnore.stdout).toContain("Path `missing.ts` does not exist");
    expect(gitignored.stdout).toBe(`${join("local", "AGENTS.md")}\n`);
  });
});

describe("compiled binary", () => {
  const bin = process.env.AGENTFILE_LINTER_TEST_BINARY ?? join(import.meta.dir, "..", "dist", "agentfile-linter");
  const testBinary = test.skipIf(!process.env.AGENTFILE_LINTER_TEST_BINARY && !existsSync(bin));

  testBinary("dist/agentfile-linter ignores Bun runtime config in the scanned project", async () => {
    const root = makeProject({
      "AGENTS.md": "`missing.ts`\n",
      "bunfig.toml": "invalid [ config\n",
      ".env": "FORCE_COLOR=1\n",
    });
    const proc = Bun.spawn([bin], { cwd: root, stdout: "pipe", stderr: "pipe", env: {} });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(stdout).toContain("Path `missing.ts` does not exist");
    expect(stdout).not.toContain("\x1b[");
  });
});
