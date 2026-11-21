import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  test("`contextlint .` works without config and exits 1 on errors", async () => {
    const root = makeProject({ "AGENTS.md": "# Hi\n\nSee `src/missing.ts`.\n" });
    const { stdout, code } = await cli(root, ".");
    expect(code).toBe(1);
    expect(stdout).toContain("× context(no-missing-path): Path `src/missing.ts` does not exist");
    expect(stdout).toContain("╭─[AGENTS.md:3:6]");
    expect(stdout).toContain("Found 0 warnings and 1 error.");
    expect(stdout).toContain("on 1 file with 4 rules");
  });

  test("exits 0 when clean, and with warnings unless --deny-warnings / --max-warnings", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts`\n" });
    expect((await cli(root, "-W", "all")).code).toBe(0);
    expect((await cli(root, "-W", "all", "--deny-warnings")).code).toBe(1);
    expect((await cli(root, "-W", "all", "--max-warnings", "0")).code).toBe(1);
    expect((await cli(root, "-W", "all", "--max-warnings=1")).code).toBe(0);
    expect((await cli(root, "-A", "all")).code).toBe(0);
  });

  test("--quiet hides warnings; --silent hides everything", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts` `pnpm dev`\n" });
    const quiet = await cli(root, "-W", "no-missing-path", "--quiet", "-f", "unix");
    expect(quiet.stdout).not.toContain("missing.ts");
    expect(quiet.stdout).toContain("no-missing-script");
    const silent = await cli(root, "--silent");
    expect(silent.stdout).toBe("");
    expect(silent.code).toBe(1);
  });

  test("json, stylish, github and unix formats", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts`\n" });
    const json = JSON.parse((await cli(root, "-f", "json")).stdout);
    expect(json).toMatchObject({
      errors: 1,
      warnings: 0,
      number_of_files: 1,
      diagnostics: [
        {
          code: "context(no-missing-path)",
          rule: "context/no-missing-path",
          severity: "error",
          filename: "AGENTS.md",
          start: { line: 1, column: 2 },
        },
      ],
    });
    expect((await cli(root, "-f", "stylish")).stdout).toContain(
      "  1:2  error  Path `missing.ts` does not exist  context/no-missing-path",
    );
    expect((await cli(root, "--format=github")).stdout).toStartWith(
      "::error file=AGENTS.md,line=1,endLine=1,col=2,endColumn=12,title=context/no-missing-path::",
    );
    expect((await cli(root, "-f", "unix")).stdout).toBe(
      "AGENTS.md:1:2: Path `missing.ts` does not exist [Error/context/no-missing-path]\n\n1 problem\n",
    );
  });

  test("usage and config errors exit 2", async () => {
    const root = makeProject({ ".contextlintrc.json": '{ "rules": { "nope": "error" } }' });
    expect(await cli(root)).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown rule "nope"') });
    expect((await cli(root, "--nope")).code).toBe(2);
    expect((await cli(root, "-f", "xml", "-c", "x.json")).code).toBe(2);
  });

  test("--init, --rules, --print-config, --version, --help", async () => {
    const root = makeProject({});
    expect((await cli(root, "--init")).code).toBe(0);
    const config = Bun.JSONC.parse(readFileSync(join(root, ".contextlintrc.json"), "utf8"));
    expect(config).toEqual({ categories: { recommended: "error" }, rules: {}, ignorePatterns: [] });
    expect((await cli(root, "--init")).code).toBe(2);

    expect((await cli(root, "--rules")).stdout).toContain("context/no-agent-files-drift  recommended  error");
    const printed = JSON.parse((await cli(root, "--print-config", "-A", "no-missing-script")).stdout);
    expect(printed.configFile).toBe(".contextlintrc.json");
    expect(printed.rules["context/no-missing-script"]).toBe("off");
    expect((await cli(root, "-V")).stdout).toMatch(/^contextlint \d+\.\d+\.\d+\n$/);
    expect((await cli(root, "-h")).stdout).toContain("Usage: contextlint [OPTIONS] [PATH]...");
  });

  test("--init preserves an existing JSONC config", async () => {
    const root = makeProject({
      ".contextlintrc.jsonc": { categories: { recommended: "off" } },
      "AGENTS.md": "`missing.ts`\n",
    });
    expect(await cli(root, "--init")).toMatchObject({ code: 2, stderr: ".contextlintrc.jsonc already exists.\n" });
    expect(existsSync(join(root, ".contextlintrc.json"))).toBe(false);
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
    const { stdout, code } = await cli(root, "--debug", "files");
    expect(code).toBe(0);
    expect(stdout).toBe("AGENTS.md\npackages/a/GEMINI.md\n");
    expect((await cli(root, "--debug=files", "packages")).stdout).toBe("packages/a/GEMINI.md\n");
    expect((await cli(root, "--debug", "files", "--no-ignore")).stdout).toBe(
      "AGENTS.md\nignored/AGENTS.md\npackages/a/GEMINI.md\n",
    );
  });

  test("--debug rejects unknown options", async () => {
    const { code, stderr } = await cli(makeProject({}), "--debug", "files,timings");
    expect(code).toBe(2);
    expect(stderr).toContain("'timings' is not a known debug option (available: files)");
  });

  test("prints a hint when no context files are found", async () => {
    const root = makeProject({ "README.md": "" });
    const { stderr, code } = await cli(root);
    expect(code).toBe(0);
    expect(stderr).toContain("No context files found");
  });

  test("warns when an explicitly named file is skipped by a configured ignore", async () => {
    const root = makeProject({
      ".contextlintrc.json": { ignorePatterns: ["generated/"] },
      ".gitignore": "local/\n",
      "generated/AGENTS.md": "`missing.ts`\n",
      "local/AGENTS.md": "# Local instructions\n",
    });
    const file = join("generated", "AGENTS.md");
    const { stdout, stderr, code } = await cli(root, file);
    expect(code).toBe(0);
    expect(stdout).toContain("File skipped because it matches an ignore pattern");
    expect(stdout).toContain("Found 1 warning and 0 errors.");
    expect(stdout).not.toContain("missing.ts");
    expect(stderr).toBe("");

    const denied = await cli(root, "-f", "json", "--deny-warnings", file);
    expect(denied.code).toBe(1);
    expect(JSON.parse(denied.stdout)).toMatchObject({
      number_of_files: 0,
      warnings: 1,
      diagnostics: [{ filename: file, severity: "warning", rule: null }],
    });
    expect((await cli(root, "--no-ignore", file)).stdout).toContain("Path `missing.ts` does not exist");
    expect((await cli(root, "--debug", "files", ".")).stdout).toBe("");
    expect((await cli(root, "--debug", "files", join("local", "AGENTS.md"))).stdout).toBe(
      `${join("local", "AGENTS.md")}\n`,
    );
  });
});

describe("compiled binary", () => {
  const bin = process.env.CONTEXTLINT_TEST_BINARY ?? join(import.meta.dir, "..", "dist", "contextlint");
  const testBinary = test.skipIf(!process.env.CONTEXTLINT_TEST_BINARY && !existsSync(bin));

  testBinary("dist/contextlint lints a project", async () => {
    const root = makeProject({ "AGENTS.md": "`missing.ts`\n", "CLAUDE.md": "@AGENTS.md\n" });
    const proc = Bun.spawn([bin, "-f", "unix"], {
      cwd: root,
      stdout: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(stdout).toContain("AGENTS.md:1:2: Path `missing.ts` does not exist");
  });

  testBinary("dist/contextlint ignores Bun runtime config in the scanned project", async () => {
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
