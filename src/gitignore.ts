import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

/** Converts a platform path to the forward-slash form `ignore` expects. */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function readLines(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readGitConfig(root: string): string | null {
  const gitPath = join(root, ".git");
  const config = readLines(join(gitPath, "config"));
  if (config !== null) return config;
  const pointer = /^gitdir:\s*(.+)$/im.exec(readLines(gitPath) ?? "")?.[1]?.trim();
  if (!pointer) return null;
  const gitDir = resolve(root, pointer);
  const commonDir = readLines(join(gitDir, "commondir"))?.trim();
  return readLines(resolve(gitDir, commonDir || ".", "config"));
}

function gitIgnoreCase(root: string): boolean {
  let core = false;
  let ignoreCase = false;
  for (const line of readGitConfig(root)?.split(/\r?\n/) ?? []) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      core = section[1]?.toLowerCase() === "core";
    } else if (core) {
      const setting = /^\s*ignorecase\s*(?:=\s*(?:"([^"]*)"|([^#;]*?))\s*)?(?:[#;].*)?$/i.exec(line);
      if (setting) {
        const value = (setting[1] ?? setting[2] ?? "true").trim();
        ignoreCase = /^(?:true|yes|on)$/i.test(value) || (/^[+-]?\d+$/.test(value) && Number(value) !== 0);
      }
    }
  }
  return ignoreCase;
}

/**
 * Evaluates `.gitignore` files (nested ones included) below a root directory,
 * plus `.git/info/exclude`. Directory-level ignore files are loaded lazily.
 */
export class GitIgnoreTree {
  private readonly cache = new Map<string, Ignore | null>();
  private readonly ignoreCase: boolean;

  constructor(readonly root: string) {
    this.ignoreCase = gitIgnoreCase(root);
  }

  private load(dir: string): Ignore | null {
    let ig = this.cache.get(dir);
    if (ig !== undefined) return ig;
    const parts: string[] = [];
    if (dir === this.root) {
      const exclude = readLines(join(dir, ".git", "info", "exclude"));
      if (exclude) parts.push(exclude);
    }
    const own = readLines(join(dir, ".gitignore"));
    if (own) parts.push(own);
    ig = parts.length ? ignore({ allowRelativePaths: true, ignoreCase: this.ignoreCase }).add(parts.join("\n")) : null;
    this.cache.set(dir, ig);
    return ig;
  }

  /**
   * Checks a single path against the ignore files of its ancestor directories,
   * assuming none of its parent directories is ignored.
   */
  isEntryIgnored(absPath: string, isDir: boolean): boolean {
    const rel = toPosix(relative(this.root, absPath));
    if (!rel || rel.startsWith("..")) return false;
    const segments = rel.split("/");
    let ignored = false;
    let dir = this.root;
    for (let i = 0; i < segments.length; i++) {
      const ig = this.load(dir);
      if (ig) {
        const relToDir = segments.slice(i).join("/") + (isDir ? "/" : "");
        const result = ig.test(relToDir);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      dir = join(dir, segments[i] as string);
    }
    return ignored;
  }

  /**
   * Checks whether a path is ignored, including through any ignored parent directory.
   * When `isDir` is unknown (e.g. the path doesn't exist), both forms are tested.
   */
  isIgnored(absPath: string, isDir?: boolean): boolean {
    const rel = toPosix(relative(this.root, absPath));
    if (!rel || rel.startsWith("..")) return false;
    const segments = rel.split("/");
    let current = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = join(current, segments[i] as string);
      if (this.isEntryIgnored(current, true)) return true;
    }
    if (isDir === undefined) {
      return this.isEntryIgnored(absPath, false) || this.isEntryIgnored(absPath, true);
    }
    return this.isEntryIgnored(absPath, isDir);
  }
}

/** A set of gitignore-style patterns anchored at a base directory. */
export class PatternIgnore {
  private readonly ig: Ignore;

  constructor(
    readonly base: string,
    patterns: string[],
  ) {
    this.ig = ignore({ allowRelativePaths: true }).add(patterns);
  }

  isIgnored(absPath: string, isDir: boolean): boolean {
    const rel = toPosix(relative(this.base, absPath));
    if (!rel || rel.startsWith("..")) return false;
    return this.ig.ignores(rel + (isDir ? "/" : ""));
  }
}
