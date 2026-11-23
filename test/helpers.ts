import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliRuleFlag } from "#src/config.ts";
import { type LintOptions, lint } from "#src/linter.ts";
import type { Diagnostic } from "#src/types.ts";

export type FileSpec = string | { symlink: string } | Record<string, unknown>;

const created: string[] = [];

/**
 * Deletes every project `makeProject()` created. `test/setup.ts` calls it once per run: an
 * `afterAll` here would only run after the first test file that imports this module.
 */
export function removeTempProjects() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Creates a temporary project. String values are written verbatim, objects as
 * JSON, `{ symlink: target }` creates a symlink. A `.git` dir marks the root.
 */
export function makeProject(files: Record<string, FileSpec>, { git = true } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentfile-linter-test-")));
  created.push(root);
  if (git) mkdirSync(join(root, ".git"));
  for (const [path, spec] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    if (path.endsWith("/")) {
      mkdirSync(abs, { recursive: true });
    } else if (typeof spec === "string") {
      writeFileSync(abs, spec);
    } else if ("symlink" in spec && typeof spec.symlink === "string") {
      symlinkSync(spec.symlink, abs);
    } else {
      writeFileSync(abs, JSON.stringify(spec, null, 2));
    }
  }
  return root;
}

/** Environment for test git commands: no user/system config, fixed identity. */
function gitEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

/** Runs git in `root`; throws when it fails. */
export function runGit(root: string, args: string[], env: Record<string, string> = {}): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, env: gitEnv(env), stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

/**
 * Commits `paths` (default: everything) in `root`, dated `daysAgo` days in the
 * past. Initializes a repository first when there is none.
 */
export function commit(root: string, { daysAgo = 0, paths = ["."] }: { daysAgo?: number; paths?: string[] } = {}) {
  if (!existsSync(join(root, ".git", "HEAD"))) runGit(root, ["init", "-q"]);
  const date = `${Math.floor(Date.now() / 1000 - daysAgo * 24 * 60 * 60)} +0000`;
  runGit(root, ["add", "--", ...paths]);
  runGit(root, ["commit", "-q", "--no-verify", "-m", `${daysAgo} days ago`, "--", ...paths], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

export interface SimpleDiagnostic {
  file: string;
  rule: string | null;
  line: number;
  column: number;
  message: string;
  help: string | undefined;
  severity: string;
}

export async function run(root: string, options: Omit<LintOptions, "cwd"> = {}): Promise<SimpleDiagnostic[]> {
  const result = await lint({ cwd: root, ...options });
  return result.files.flatMap((f) =>
    f.diagnostics.map((d: Diagnostic) => ({
      file: f.filePath.slice(root.length + 1),
      rule: d.ruleId,
      line: d.start.line,
      column: d.start.column,
      message: d.message,
      help: d.help,
      severity: d.severity,
    })),
  );
}

/** Runs a single rule (all others disabled). */
export function runRule(root: string, rule: string, options: Omit<LintOptions, "cwd" | "ruleFlags"> = {}) {
  const ruleFlags: CliRuleFlag[] = [
    { severity: "off", target: "all" },
    { severity: "error", target: rule },
  ];
  return run(root, { config: false, ...options, ruleFlags });
}

export const messages = (diagnostics: SimpleDiagnostic[]) => diagnostics.map((d) => d.message);

/** The message of the error `promise` rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the promise to reject");
}
