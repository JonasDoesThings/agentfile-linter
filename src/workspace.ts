import { dirname, join, relative, resolve } from "node:path";

import { toPosix } from "./gitignore.ts";
import type { Project } from "./project.ts";
import { isRecord } from "./util.ts";

export interface PackageInfo {
  /** Absolute directory containing package.json. */
  dir: string;
  name: string | undefined;
  scripts: Record<string, string>;
  dependencies: Set<string>;
  bin: Set<string>;
}

interface PackageJson {
  name?: unknown;
  scripts?: unknown;
  workspaces?: unknown;
  bin?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

/** Binaries whose name differs from the package providing them. */
const KNOWN_BIN_PACKAGES: Record<string, string[]> = {
  tsc: ["typescript"],
  tsserver: ["typescript"],
  changeset: ["@changesets/cli"],
  playwright: ["@playwright/test"],
  biome: ["@biomejs/biome"],
  ng: ["@angular/cli"],
  nuxi: ["nuxt", "nuxi"],
  "svelte-kit": ["@sveltejs/kit"],
  swc: ["@swc/cli"],
  sb: ["storybook"],
  "graphql-codegen": ["@graphql-codegen/cli"],
  "gql-gen": ["@graphql-codegen/cli"],
  netlify: ["netlify-cli"],
  firebase: ["firebase-tools"],
  "run-p": ["npm-run-all", "npm-run-all2"],
  "run-s": ["npm-run-all", "npm-run-all2"],
  ncu: ["npm-check-updates"],
  commitlint: ["@commitlint/cli"],
  attw: ["@arethetypeswrong/cli"],
  "vue-cli-service": ["@vue/cli-service"],
  webpack: ["webpack-cli"],
  tailwindcss: ["@tailwindcss/cli"],
  postcss: ["postcss-cli"],
  dotenv: ["dotenv-cli"],
  "sentry-cli": ["@sentry/cli"],
  cdk: ["aws-cdk"],
  sls: ["serverless"],
  "markdownlint-cli2": ["markdownlint-cli2"],
  markdownlint: ["markdownlint-cli"],
  remark: ["remark-cli"],
  "react-native": ["react-native", "@react-native-community/cli"],
};

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

function workspacePatterns(manifest: PackageJson | null): string[] | null {
  if (!manifest) return null;
  const ws = manifest.workspaces;
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (typeof ws === "object" && ws !== null && Array.isArray((ws as { packages?: unknown }).packages)) {
    return (ws as { packages: unknown[] }).packages.filter((p): p is string => typeof p === "string");
  }
  return null;
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Package and workspace knowledge for a {@link Project}. */
export class Workspaces {
  private readonly packageCache = new Map<string, PackageInfo | null>();
  private readonly membersCache = new Map<string, PackageInfo[]>();
  private allPackagesCache: PackageInfo[] | undefined;

  constructor(private readonly project: Project) {}

  /** Reads the package.json in `dir` (cached). */
  packageAt(dir: string): PackageInfo | null {
    let info = this.packageCache.get(dir);
    if (info !== undefined) return info;
    const raw = this.project.readJson(join(dir, "package.json"));
    const manifest: PackageJson | null = isRecord(raw) ? raw : null;
    if (!manifest || typeof manifest !== "object") {
      info = null;
    } else {
      const deps = new Set<string>();
      for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
        for (const dep of Object.keys(stringRecord(manifest[key]))) deps.add(dep);
      }
      const name = typeof manifest.name === "string" ? manifest.name : undefined;
      const bin = new Set<string>();
      if (typeof manifest.bin === "string" && name) bin.add(name.replace(/^@[^/]+\//, ""));
      else for (const b of Object.keys(stringRecord(manifest.bin))) bin.add(b);
      info = { dir, name, scripts: stringRecord(manifest.scripts), dependencies: deps, bin };
    }
    this.packageCache.set(dir, info);
    return info;
  }

  /** The nearest package.json at or above `dir` (bounded by the project root). */
  nearestPackage(dir: string): PackageInfo | null {
    for (const candidate of this.project.ancestorsUpToRoot(dir)) {
      const info = this.packageAt(candidate);
      if (info) return info;
    }
    return null;
  }

  /** Patterns declared by pnpm-workspace.yaml or package.json#workspaces in `dir`, if any. */
  private patternsAt(dir: string, manifestOnly: boolean): string[] | null {
    const workspace = manifestOnly ? null : this.pnpmWorkspaceAt(dir);
    if (workspace)
      return Array.isArray(workspace.packages)
        ? workspace.packages.filter((p): p is string => typeof p === "string")
        : [];
    const raw = this.project.readJson(join(dir, "package.json"));
    return workspacePatterns(isRecord(raw) ? raw : null);
  }

  private pnpmWorkspaceAt(dir: string): Record<string, unknown> | null {
    return this.project.memo(`pnpm-workspace:${dir}`, () => {
      const text = this.project.readText(join(dir, "pnpm-workspace.yaml"));
      if (text === null) return null;
      try {
        const raw: unknown = Bun.YAML.parse(text);
        return isRecord(raw) ? raw : {};
      } catch {
        return {};
      }
    });
  }

  includesWorkspaceRoot(root: string, manager: "npm" | "pnpm" | "yarn" | "bun"): boolean {
    if (manager !== "npm" && manager !== "pnpm") return true;
    if (manager === "pnpm") {
      const setting = this.pnpmWorkspaceAt(root)?.includeWorkspaceRoot;
      if (typeof setting === "boolean") return setting;
    }
    return this.project.memo(`include-workspace-root:${root}`, () => {
      const npmrc = this.project.readText(join(root, ".npmrc"));
      const setting = [...(npmrc ?? "").matchAll(/^\s*include-workspace-root\s*=\s*(true|false)\s*$/gim)].at(-1);
      return setting?.[1]?.toLowerCase() === "true";
    });
  }

  /** The workspace root enclosing `dir` (the outermost directory declaring workspaces), if any. */
  workspaceRoot(dir: string, manifestOnly = false): string | null {
    let found: string | null = null;
    for (const candidate of this.project.ancestorsUpToRoot(dir)) {
      if (this.patternsAt(candidate, manifestOnly) !== null) found = candidate;
    }
    return found;
  }

  /** All member packages of the workspace rooted at `root` (excluding the root package itself). */
  members(root: string, manifestOnly = false): PackageInfo[] {
    const key = `${manifestOnly}:${root}`;
    const cached = this.membersCache.get(key);
    if (cached) return cached;
    const patterns = this.patternsAt(root, manifestOnly) ?? [];
    const include = patterns.filter((p) => !p.startsWith("!")).map((p) => new Bun.Glob(normalizePattern(p)));
    const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => new Bun.Glob(normalizePattern(p.slice(1))));
    const members: PackageInfo[] = [];
    for (const pkg of this.allPackages()) {
      if (pkg.dir === root) continue;
      const rel = toPosix(relative(root, pkg.dir));
      if (rel.startsWith("..")) continue;
      if (include.some((g) => g.match(rel)) && !exclude.some((g) => g.match(rel))) members.push(pkg);
    }
    this.membersCache.set(key, members);
    return members;
  }

  /** Every package.json in the project (respecting .gitignore). */
  allPackages(): PackageInfo[] {
    if (this.allPackagesCache) return this.allPackagesCache;
    const out: PackageInfo[] = [];
    for (const file of this.project.getIndex().files) {
      if (file !== "package.json" && !file.endsWith("/package.json")) continue;
      const info = this.packageAt(dirname(join(this.project.root, file)));
      if (info) out.push(info);
    }
    this.allPackagesCache = out;
    return out;
  }

  /**
   * Resolves a workspace selector (pnpm `--filter`, npm `--workspace`, bun `--filter`,
   * `yarn workspace <name>`) to packages. Returns `null` when the selector can't be
   * evaluated statically (git ranges, exclusions).
   */
  resolveSelector(selector: string, wsRoot: string, cwd: string): PackageInfo[] | null {
    let sel = selector.trim();
    if (!sel || sel.startsWith("!") || sel.includes("[")) return null;
    // Dependency/dependent graph selectors: keep the core package.
    sel = sel.replace(/^\.\.\.\^?|\^?\.\.\.$/g, "").replace(/^\^/, "");
    if (!sel) return null;
    const candidates = [this.packageAt(wsRoot), ...this.members(wsRoot)].filter((p): p is PackageInfo => !!p);

    const braced = /^\{(.+)\}$/.exec(sel);
    if (braced || sel.startsWith("./") || sel.startsWith("../") || sel === ".") {
      const pathPattern = braced ? (braced[1] as string) : sel;
      const base = braced ? wsRoot : cwd;
      const abs = resolve(base, pathPattern);
      if (/[*?]/.test(pathPattern)) {
        const glob = new Bun.Glob(normalizePattern(toPosix(relative(base, abs))));
        return candidates.filter((p) => glob.match(toPosix(relative(base, p.dir))));
      }
      return candidates.filter((p) => p.dir === abs || p.dir.startsWith(`${abs}/`));
    }

    if (/[*?]/.test(sel)) {
      const glob = new Bun.Glob(sel);
      return candidates.filter((p) => p.name !== undefined && glob.match(p.name));
    }

    const exact = candidates.filter((p) => p.name === sel);
    if (exact.length) return exact;
    // pnpm lets you omit the scope when it's unambiguous.
    const unscoped = candidates.filter((p) => p.name?.endsWith(`/${sel}`));
    if (unscoped.length) return unscoped;
    // npm also accepts workspace paths without a leading "./".
    for (const base of [cwd, wsRoot]) {
      const abs = resolve(base, sel);
      const byPath = candidates.filter((p) => p.dir === abs);
      if (byPath.length) return byPath;
    }
    return [];
  }

  /** Whether `name` can be run as a binary from `pkg` (installed bin or known dependency). */
  hasBin(pkg: PackageInfo, name: string): boolean {
    const providers = new Set([name, `${name}-cli`, `@${name}/cli`, ...(KNOWN_BIN_PACKAGES[name] ?? [])]);
    const wsRoot = this.workspaceRoot(pkg.dir);
    const scopes = [pkg, wsRoot ? this.packageAt(wsRoot) : null].filter((p): p is PackageInfo => !!p);
    for (const scope of scopes) {
      if (scope.bin.has(name)) return true;
      for (const dep of scope.dependencies) {
        if (providers.has(dep) || dep.endsWith(`/${name}`)) return true;
      }
    }
    for (const dir of this.project.ancestorsUpToRoot(pkg.dir)) {
      if (this.project.exists(join(dir, "node_modules", ".bin", name))) return true;
    }
    return false;
  }
}
