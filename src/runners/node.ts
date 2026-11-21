import { join, relative, resolve } from "node:path";

import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";
import { list } from "#src/text.ts";
import { assertNever } from "#src/util.ts";
import type { PackageInfo } from "#src/workspace.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Where a script is expected to be defined. */
export type ScriptTarget =
  /** The nearest package.json of `dir`. */
  | { kind: "dir"; dir: string }
  /** The workspace root package enclosing `dir`. */
  | { kind: "workspace-root"; dir: string }
  /** Packages of the workspace enclosing `dir` (recursive runs). */
  | { kind: "recursive"; dir: string }
  /** Packages matched by workspace selectors, resolved relative to `dir`. */
  | { kind: "selectors"; selectors: string[]; dir: string; exact: boolean };

export interface ScriptInvocation {
  pm: PackageManager;
  script: string;
  /** The token naming the script (for diagnostics). */
  token: Token;
  target: ScriptTarget;
  includeWorkspaceRoot?: boolean;
  /** Whether the package manager falls back to running a binary of that name. */
  allowsBinFallback: boolean;
}

const PNPM_BUILTINS = new Set(
  (
    "add i install up update upgrade remove rm uninstall un link ln unlink import rebuild rb prune fetch " +
    "install-test it patch patch-commit patch-remove audit list ls ll la outdated why licenses exec dlx create " +
    "publish pack server store root bin setup init deploy doctor config c get set env cat-file cat-index " +
    "find-hash approve-builds ignored-builds self-update dedupe help completion sbom version login logout " +
    "whoami view info show owner adduser access bugs docs repo search star stars team token unpublish " +
    "deprecate dist-tag ping prefix profile hook org edit explore fund cache node runtime x"
  ).split(" "),
);

const YARN_BUILTINS = new Set(
  (
    "add bin cache config constraints dedupe dlx exec explain info init install link node npm pack patch " +
    "patch-commit plugin rebuild remove search set stage unlink unplug up upgrade upgrade-interactive version " +
    "why audit autoclean check create generate-lock-entry global help import licenses list login logout " +
    "outdated owner policies publish tag team sdks"
  ).split(" "),
);

const BUN_BUILTINS = new Set(
  (
    "test x repl exec install i add a remove rm update outdated link unlink publish patch patch-commit pm " +
    "info why audit init create c upgrade build completions discord help feedback"
  ).split(" "),
);

const NPM_SCRIPT_ALIASES: Record<string, string> = {
  test: "test",
  t: "test",
  tst: "test",
  start: "start",
  stop: "stop",
  restart: "restart",
};

/** Flags (per package manager) that consume the following token as their value. */
const VALUE_FLAGS: Record<PackageManager, Set<string>> = {
  pnpm: new Set([
    "--filter",
    "-F",
    "--filter-prod",
    "--dir",
    "-C",
    "--workspace-concurrency",
    "--reporter",
    "--loglevel",
    "--test-pattern",
    "--changed-files-ignore-pattern",
    "--resume-from",
    "--config",
  ]),
  npm: new Set([
    "-w",
    "--workspace",
    "--prefix",
    "-C",
    "--loglevel",
    "--registry",
    "--userconfig",
    "--cache",
    "--tag",
    "--scope",
    "--script-shell",
  ]),
  yarn: new Set(["--cwd", "--network-timeout", "--cache-folder", "--modules-folder", "--mutex"]),
  bun: new Set([
    "--cwd",
    "--filter",
    "-F",
    "--elide-lines",
    "--shell",
    "--env-file",
    "--config",
    "-c",
    "--preload",
    "-r",
    "--eval",
    "-e",
    "--print",
    "-p",
  ]),
};

interface FlagState {
  selectors: string[];
  dir: string;
  recursive: boolean;
  workspaceRoot: boolean;
  includeWorkspaceRoot?: boolean;
  ifPresent: boolean;
  /** Command consumed by a flag (e.g. `bun -e`); nothing to check. */
  abort: boolean;
}

function flagValue(tokens: Token[], i: number, flag: string): { value: string | undefined; next: number } {
  const token = (tokens[i] as Token).value;
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq !== -1) return { value: token.slice(eq + 1), next: i + 1 };
  if (!token.startsWith("--") && token.length > 2 && flag.length === 2) {
    return { value: token.slice(2), next: i + 1 };
  }
  return { value: tokens[i + 1]?.value, next: i + 2 };
}

/**
 * Consumes leading flags starting at `i`. Returns the index of the first
 * non-flag token.
 */
function consumeFlags(
  pm: PackageManager,
  tokens: Token[],
  i: number,
  state: FlagState,
  resolveDir: (d: string) => string,
): number {
  while (i < tokens.length) {
    const raw = (tokens[i] as Token).value;
    if (raw === "--" || raw === "-" || !raw.startsWith("-")) return i;
    if (pm === "npm" && raw === "-ws") {
      state.recursive = true;
      i++;
      continue;
    }
    const name = raw.startsWith("--") ? (raw.split("=")[0] as string) : raw.slice(0, 2);
    if ((pm === "npm" || pm === "pnpm") && name === "--include-workspace-root") {
      state.includeWorkspaceRoot = raw !== "--include-workspace-root=false";
      i++;
      continue;
    }
    if (VALUE_FLAGS[pm].has(name)) {
      const { value, next } = flagValue(tokens, i, name);
      i = next;
      if (value === undefined) continue;
      if (["--filter", "-F", "--filter-prod", "-w", "--workspace"].includes(name)) {
        state.selectors.push(value);
      } else if (["--dir", "--prefix", "--cwd"].includes(name) || (name === "-C" && pm !== "bun")) {
        state.dir = resolveDir(value);
      } else if (pm === "bun" && ["--eval", "-e", "--print", "-p"].includes(name)) {
        state.abort = true;
      }
      continue;
    }
    if (raw === "-r" || raw === "--recursive") state.recursive = true;
    else if (pm === "npm" && name === "--workspaces") state.recursive = raw !== "--workspaces=false";
    else if (pm === "pnpm" && (raw === "-w" || raw === "--workspace-root")) state.workspaceRoot = true;
    else if (raw === "--if-present") state.ifPresent = true;
    i++;
  }
  return i;
}

function makeTarget(state: FlagState): ScriptTarget {
  if (state.selectors.length) return { kind: "selectors", selectors: state.selectors, dir: state.dir, exact: true };
  if (state.recursive) return { kind: "recursive", dir: state.dir };
  if (state.workspaceRoot) return { kind: "workspace-root", dir: state.dir };
  return { kind: "dir", dir: state.dir };
}

function isScriptName(name: string): boolean {
  // Files (`bun src/index.ts`), regexes (`pnpm run /^dev/`) and dynamic names aren't checked.
  return !!name && !/[/$*{}]/.test(name) && !name.startsWith(".") && !name.startsWith("-");
}

/**
 * Interprets a tokenized command as a package-manager script invocation.
 * `cwd` is the absolute directory the command runs in.
 */
export function parseScriptInvocation(
  tokens: Token[],
  cwd: string,
  resolveDir: (base: string, d: string) => string,
): ScriptInvocation | null {
  const args = tokens;
  const pmToken = args[0]?.value;
  if (pmToken !== "npm" && pmToken !== "pnpm" && pmToken !== "yarn" && pmToken !== "bun") return null;
  const pm: PackageManager = pmToken;
  const state: FlagState = {
    selectors: [],
    dir: cwd,
    recursive: false,
    workspaceRoot: false,
    ifPresent: false,
    abort: false,
  };
  const rd = (d: string) => resolveDir(state.dir, d);

  const result = (
    token: Token | undefined,
    allowsBinFallback: boolean,
    script = token?.value,
  ): ScriptInvocation | null => {
    if (!token || !script || state.ifPresent || state.abort || !isScriptName(script)) return null;
    return {
      pm,
      script,
      token,
      target: makeTarget(state),
      includeWorkspaceRoot: state.includeWorkspaceRoot,
      allowsBinFallback,
    };
  };

  if (pm === "npm") {
    // npm parses its own flags anywhere before `--`.
    const positional: Token[] = [];
    let i = 1;
    while (i < args.length) {
      const t = args[i] as Token;
      if (t.value === "--") break;
      if (t.value.startsWith("-")) {
        const next = consumeFlags(pm, args, i, state, rd);
        i = next === i ? i + 1 : next;
        continue;
      }
      positional.push(t);
      i++;
    }
    const cmd = positional[0];
    if (!cmd) return null;
    if (["run", "run-script", "rum", "urn"].includes(cmd.value)) return result(positional[1], false);
    const alias = NPM_SCRIPT_ALIASES[cmd.value];
    if (alias) return result(cmd, false, alias);
    return null;
  }

  let i = consumeFlags(pm, args, 1, state, rd);
  let cmd = args[i];
  if (!cmd || state.abort) return null;

  if (pm === "pnpm") {
    if (["recursive", "m", "multi"].includes(cmd.value)) {
      state.recursive = true;
      i = consumeFlags(pm, args, i + 1, state, rd);
      cmd = args[i];
      if (!cmd) return null;
    }
    if (cmd.value === "run" || cmd.value === "run-script") {
      i = consumeFlags(pm, args, i + 1, state, rd);
      return result(args[i], false);
    }
    if (["test", "t", "tst"].includes(cmd.value)) return result(cmd, false, "test");
    if (cmd.value === "start") return result(cmd, false);
    if (PNPM_BUILTINS.has(cmd.value)) return null;
    return result(cmd, true);
  }

  if (pm === "yarn") {
    if (cmd.value === "workspace") {
      const name = args[i + 1];
      if (!name) return null;
      state.selectors.push(name.value);
      i = consumeFlags(pm, args, i + 2, state, rd);
      let sub = args[i];
      if (!sub) return null;
      if (sub.value === "run") {
        i = consumeFlags(pm, args, i + 1, state, rd);
        sub = args[i];
      } else if (YARN_BUILTINS.has(sub.value) || sub.value === "workspace" || sub.value === "workspaces") {
        return null;
      }
      return result(sub, true);
    }
    if (cmd.value === "workspaces") {
      const sub = args[i + 1];
      if (!sub) return null;
      state.recursive = true;
      if (sub.value === "run") return result(args[i + 2], true);
      if (sub.value !== "foreach") return null;
      // yarn workspaces foreach [flags] [run] <script>
      let j = i + 2;
      const foreachValueFlags = new Set(["--from", "--include", "--exclude", "-j", "--jobs"]);
      while (j < args.length && (args[j] as Token).value.startsWith("-")) {
        const flag = (args[j] as Token).value;
        j += foreachValueFlags.has(flag) ? 2 : 1;
      }
      let target = args[j];
      if (target?.value === "run") target = args[j + 1];
      else if (target && (YARN_BUILTINS.has(target.value) || target.value === "exec")) return null;
      return result(target, true);
    }
    if (cmd.value === "run") {
      i = consumeFlags(pm, args, i + 1, state, rd);
      return result(args[i], true);
    }
    if (YARN_BUILTINS.has(cmd.value)) return null;
    return result(cmd, true);
  }

  // bun
  if (cmd.value === "run") {
    i = consumeFlags(pm, args, i + 1, state, rd);
    if (state.abort) return null;
    return result(args[i], true);
  }
  if (BUN_BUILTINS.has(cmd.value)) return null;
  return result(cmd, true);
}

function describeDir(project: Project, dir: string): string {
  return relative(project.root, dir) || "the project root";
}

function manifestPath(project: Project, pkg: PackageInfo): string {
  return relative(project.root, join(pkg.dir, "package.json"));
}

type TargetResolution = { packages: PackageInfo[] } | { message: string; help?: string } | null;

function includesWorkspaceRoot(inv: ScriptInvocation, project: Project, root: string): boolean {
  if (inv.includeWorkspaceRoot !== undefined) return inv.includeWorkspaceRoot;
  return project.workspaces.includesWorkspaceRoot(root, inv.pm);
}

function resolveTarget(inv: ScriptInvocation, project: Project): TargetResolution {
  const ws = project.workspaces;
  const target = inv.target;
  switch (target.kind) {
    case "dir": {
      const pkg = ws.nearestPackage(target.dir);
      if (pkg) return { packages: [pkg] };
      // No manifest to run from. Stay quiet if the script exists somewhere in the project.
      if (ws.allPackages().some((p) => p.scripts[inv.script] !== undefined)) return null;
      return {
        message: `No package.json found for \`${inv.script}\` (run from ${describeDir(project, target.dir)})`,
      };
    }
    case "workspace-root": {
      const root = ws.workspaceRoot(target.dir);
      const pkg = root ? ws.packageAt(root) : ws.nearestPackage(target.dir);
      return pkg ? { packages: [pkg] } : { message: `No workspace root package.json found for \`${inv.script}\`` };
    }
    case "recursive": {
      const manifestOnly = inv.pm === "npm";
      const root = ws.workspaceRoot(target.dir, manifestOnly);
      if (!root) {
        if (inv.pm === "npm") return { message: `No workspaces found for \`${inv.script}\`` };
        const pkg = ws.nearestPackage(target.dir);
        return pkg
          ? { packages: [pkg] }
          : { message: `No package.json found for \`${inv.script}\` (run from ${describeDir(project, target.dir)})` };
      }
      const members = ws.members(root, manifestOnly);
      if (inv.pm === "npm" && !members.length) return { message: `No workspaces found for \`${inv.script}\`` };
      const rootPackage = includesWorkspaceRoot(inv, project, root) ? ws.packageAt(root) : null;
      if (inv.pm === "pnpm" && !rootPackage && !members.length) return null;
      return { packages: rootPackage ? [rootPackage, ...members] : members };
    }
    case "selectors": {
      const root = ws.workspaceRoot(target.dir) ?? ws.nearestPackage(target.dir)?.dir ?? project.root;
      const packages: PackageInfo[] = [];
      for (const selector of target.selectors) {
        const matched = ws.resolveSelector(selector, root, target.dir);
        if (matched === null) return null; // can't evaluate statically
        if (matched.length === 0) {
          const names = [ws.packageAt(root), ...ws.members(root)].map((p) => p?.name).filter((n): n is string => !!n);
          return {
            message: `No workspace package matches \`${selector}\` (running \`${inv.script}\`)`,
            help: names.length ? `Workspace packages: ${list(names, 10)}` : undefined,
          };
        }
        packages.push(...matched);
      }
      if (inv.pm === "npm" && includesWorkspaceRoot(inv, project, root)) {
        const rootPackage = ws.packageAt(root);
        if (rootPackage) packages.unshift(rootPackage);
      }
      return { packages: [...new Set(packages)] };
    }
    default:
      return assertNever(target);
  }
}

function checkInvocation(inv: ScriptInvocation, project: Project): Problem[] {
  // Bun can run a file in its working directory even when there is no package.json.
  if (inv.pm === "bun" && inv.target.kind === "dir" && project.isFile(resolve(inv.target.dir, inv.script))) {
    return [];
  }
  const ws = project.workspaces;
  const resolution = resolveTarget(inv, project);
  if (resolution === null) return [];
  if ("message" in resolution) return [{ token: inv.token, name: inv.script, ...resolution }];
  const { packages } = resolution;
  const canRun = (pkg: PackageInfo) => {
    if (pkg.scripts[inv.script] !== undefined) return true;
    // npm restart falls back to `npm stop --if-present && npm start`.
    if (inv.pm === "npm" && inv.script === "restart") {
      return pkg.scripts.start !== undefined || project.isFile(join(pkg.dir, "server.js"));
    }
    // npm/pnpm start fall back to `node server.js`.
    if (inv.script === "start" && (inv.pm === "npm" || inv.pm === "pnpm")) {
      return project.exists(join(pkg.dir, "server.js"));
    }
    return inv.allowsBinFallback && ws.hasBin(pkg, inv.script);
  };
  const allRequired = inv.pm === "npm";
  if (!allRequired && packages.some(canRun)) return [];
  const missing = allRequired ? packages.filter((pkg) => !canRun(pkg)) : packages;
  if (allRequired && missing.length === 0) return [];

  const definedIn = ws
    .allPackages()
    .filter((p) => p.scripts[inv.script] !== undefined && !missing.includes(p))
    .map((p) => `\`${manifestPath(project, p)}\``);
  const single = missing.length === 1 ? (missing[0] as PackageInfo) : null;
  let help: string | undefined;
  if (definedIn.length) {
    help = `\`${inv.script}\` is defined in ${list(definedIn, 5)}`;
  } else if (single) {
    const available = Object.keys(single.scripts);
    help = available.length ? `Available scripts: ${list(available)}` : "The package defines no scripts.";
  }
  return [
    {
      token: inv.token,
      name: inv.script,
      message: single
        ? `Script \`${inv.script}\` is not defined in \`${manifestPath(project, single)}\``
        : missing.length === packages.length
          ? `Script \`${inv.script}\` is not defined in any of the ${packages.length} targeted packages`
          : `Script \`${inv.script}\` is not defined in ${list(missing.map((p) => `\`${manifestPath(project, p)}\``).toSorted())}`,
      help,
    },
  ];
}

function nodeRunner(pm: PackageManager): TaskRunner {
  return {
    id: pm,
    executables: [pm],
    check(args: Token[], ctx: RunnerContext): Problem[] {
      const invocation = parseScriptInvocation(args, ctx.cwd, (base, d) => ctx.project.resolveExisting(base, d, "dir"));
      return invocation ? checkInvocation(invocation, ctx.project) : [];
    },
  };
}

/** npm, pnpm, yarn and bun: package.json scripts, workspaces and binaries. */
export const nodeRunners: TaskRunner[] = (["npm", "pnpm", "yarn", "bun"] as const).map(nodeRunner);
