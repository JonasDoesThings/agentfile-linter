import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { GitIgnoreTree, toPosix } from "./gitignore.ts";
import { collectAnchors, parseMarkdown } from "./markdown.ts";
import { Workspaces } from "./workspace.ts";

/** Directories that are never descended into, regardless of ignore files. */
export const ALWAYS_SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** Whether `path` is `dir` or inside it (lexically, without resolving symlinks). */
export function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The path with all symlinks resolved, or null when it doesn't exist (or a link is broken). */
export function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

interface ProjectIndex {
  /** Root-relative POSIX paths of all non-ignored files. */
  files: string[];
  /** Root-relative POSIX paths of all non-ignored directories. */
  dirs: string[];
  /** Root-relative POSIX paths of the non-ignored symlinks among `files` and `dirs`. */
  symlinks: string[];
}

/**
 * Knowledge about one project (usually a git repository): file system access
 * with caching, gitignore evaluation, a lazily built index of all files, and
 * package/workspace information. Shared by all rules and files.
 */
export class Project {
  readonly gitignore: GitIgnoreTree;
  readonly workspaces: Workspaces;
  private readonly statCache = new Map<string, Stats | null>();
  private readonly dirCache = new Map<string, string[] | null>();
  private readonly anchorCache = new Map<string, Set<string> | null>();
  private readonly memoCache = new Map<string, unknown>();
  private index: ProjectIndex | undefined;

  constructor(readonly root: string) {
    this.gitignore = new GitIgnoreTree(root);
    this.workspaces = new Workspaces(this);
  }

  /** Stats a path (following symlinks). Returns null when it doesn't exist. */
  stat(absPath: string): Stats | null {
    let s = this.statCache.get(absPath);
    if (s === undefined) {
      try {
        s = statSync(absPath);
      } catch {
        s = null;
      }
      this.statCache.set(absPath, s);
    }
    return s;
  }

  exists(absPath: string): boolean {
    return this.stat(absPath) !== null;
  }

  isFile(absPath: string): boolean {
    return this.stat(absPath)?.isFile() ?? false;
  }

  isDirectory(absPath: string): boolean {
    return this.stat(absPath)?.isDirectory() ?? false;
  }

  /** Lists directory entry names (cached). Returns null when unreadable. */
  readDir(absDir: string): string[] | null {
    let entries = this.dirCache.get(absDir);
    if (entries === undefined) {
      try {
        entries = readdirSync(absDir);
      } catch {
        entries = null;
      }
      this.dirCache.set(absDir, entries);
    }
    return entries;
  }

  readText(absPath: string): string | null {
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  }

  /** Parses a JSON(C) file; null when missing or invalid. Callers narrow the result. */
  readJson(absPath: string): unknown {
    const text = this.readText(absPath);
    if (text === null) return null;
    try {
      return Bun.JSONC.parse(text);
    } catch {
      return null;
    }
  }

  /** Whether `absPath` is inside the project root (or is the root). */
  contains(absPath: string): boolean {
    return isWithin(this.root, absPath);
  }

  /** Root-relative POSIX path. */
  relative(absPath: string): string {
    return toPosix(relative(this.root, absPath));
  }

  /** `dir` and each of its ancestors up to (and including) the project root. */
  ancestorsUpToRoot(dir: string): string[] {
    const out: string[] = [];
    let current = dir;
    if (!this.contains(current)) return [dir];
    while (true) {
      out.push(current);
      if (current === this.root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return out;
  }

  /** Whether a path is excluded by git (via .gitignore) or lives in an always-skipped directory. */
  isIgnored(absPath: string, isDir?: boolean): boolean {
    const rel = this.relative(absPath);
    if (rel.split("/").some((s) => ALWAYS_SKIPPED_DIRS.has(s))) return true;
    return this.gitignore.isIgnored(absPath, isDir);
  }

  /** Lazily walks the whole project (respecting .gitignore) and returns all paths. */
  getIndex(): ProjectIndex {
    if (this.index) return this.index;
    const files: string[] = [];
    const dirs: string[] = [];
    const symlinks: string[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          // Record symlinks by their target type but never descend into them (avoids cycles).
          isDir = this.isDirectory(abs);
          if (this.gitignore.isEntryIgnored(abs, isDir)) continue;
          (isDir ? dirs : files).push(entryRel);
          symlinks.push(entryRel);
          continue;
        }
        if (this.gitignore.isEntryIgnored(abs, isDir)) continue;
        if (isDir) {
          dirs.push(entryRel);
          walk(abs, entryRel);
        } else {
          files.push(entryRel);
        }
      }
    };
    walk(this.root, "");
    this.index = { files, dirs, symlinks };
    return this.index;
  }

  /**
   * Finds project paths equal to `relPath` or ending in `/<relPath>`.
   * `kind` restricts the search to files or directories.
   */
  findBySuffix(relPath: string, kind: "file" | "dir" | "any" = "any", limit = 5): string[] {
    const index = this.getIndex();
    const pools = kind === "file" ? [index.files] : kind === "dir" ? [index.dirs] : [index.files, index.dirs];
    const suffix = `/${relPath}`;
    const out: string[] = [];
    for (const pool of pools) {
      for (const p of pool) {
        if (p === relPath || p.endsWith(suffix)) {
          out.push(p);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  /** Whether a glob (relative to `baseDir`) matches at least one indexed path. */
  globMatches(pattern: string, baseDir: string): boolean {
    const directoryPrefix = /^(?:\.{1,2}\/)+/.exec(pattern)?.[0] ?? "";
    const searchDir = resolve(baseDir, directoryPrefix);
    if (!this.contains(searchDir)) return false;
    const glob = new Bun.Glob(pattern.slice(directoryPrefix.length));
    const baseRel = this.relative(searchDir);
    const prefix = baseRel ? `${baseRel}/` : "";
    const matches = (path: string) => path.startsWith(prefix) && glob.match(path.slice(prefix.length));
    const index = this.getIndex();
    return index.files.some(matches) || index.dirs.some(matches);
  }

  /** Heading anchors of a Markdown file (cached). */
  anchorsOf(absPath: string): Set<string> | null {
    let anchors = this.anchorCache.get(absPath);
    if (anchors === undefined) {
      const text = this.readText(absPath);
      anchors = text === null ? null : normalizeAnchors(collectAnchors(parseMarkdown(text)));
      this.anchorCache.set(absPath, anchors);
    }
    return anchors;
  }

  /**
   * Resolves a relative path written in a command: against `dir` first, then its
   * ancestors up to the root (the first existing match wins), like references in
   * prose. Falls back to `dir` when nothing exists.
   */
  resolveExisting(dir: string, rel: string, kind: "dir" | "file" | "any" = "any"): string {
    if (isAbsolute(rel)) return rel;
    for (const base of this.ancestorsUpToRoot(dir)) {
      const abs = resolve(base, rel);
      if (kind === "dir" ? this.isDirectory(abs) : kind === "file" ? this.isFile(abs) : this.exists(abs)) return abs;
    }
    return resolve(dir, rel);
  }

  /** Caches an arbitrary computation (e.g. a parsed Makefile) for the lifetime of the project. */
  memo<T>(key: string, compute: () => T): T {
    if (!this.memoCache.has(key)) this.memoCache.set(key, compute());
    return this.memoCache.get(key) as T;
  }

  /**
   * Finds the first file named one of `names` in `dir` or its ancestors (up to the root).
   * With `ignoreCase`, names are compared case-insensitively (e.g. `justfile`).
   */
  findUp(dir: string, names: readonly string[], ignoreCase = false): string | null {
    for (const candidate of this.ancestorsUpToRoot(dir)) {
      const found = this.findIn(candidate, names, ignoreCase);
      if (found) return found;
    }
    return null;
  }

  /** Finds a file named one of `names` (in order of preference) directly in `dir`. */
  findIn(dir: string, names: readonly string[], ignoreCase = false): string | null {
    // Compare against real directory entries: on case-insensitive file systems a
    // stat of `makefile` would also succeed for `Makefile`.
    const entries = this.readDir(dir) ?? [];
    if (!ignoreCase) {
      for (const name of names) if (entries.includes(name) && this.isFile(join(dir, name))) return join(dir, name);
      return null;
    }
    for (const name of names) {
      const entry = entries.find((e) => e.toLowerCase() === name.toLowerCase());
      if (entry && this.isFile(join(dir, entry))) return join(dir, entry);
    }
    return null;
  }

  /** Absolute paths of all (non-ignored) project files whose name is one of `names`. */
  findFilesNamed(names: readonly string[], ignoreCase = false): string[] {
    const wanted = new Set(ignoreCase ? names.map((n) => n.toLowerCase()) : names);
    return this.getIndex()
      .files.filter((f) => {
        const base = f.slice(f.lastIndexOf("/") + 1);
        return wanted.has(ignoreCase ? base.toLowerCase() : base);
      })
      .map((f) => join(this.root, f));
  }

  /** Whether `absPath` is a symbolic link. */
  isSymlink(absPath: string): boolean {
    try {
      return lstatSync(absPath).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

export function normalizeAnchor(anchor: string): string {
  let decoded = anchor;
  try {
    decoded = decodeURIComponent(anchor);
  } catch {
    // keep raw
  }
  return decoded.toLowerCase();
}

export function normalizeAnchors(anchors: Set<string>): Set<string> {
  return new Set([...anchors].map(normalizeAnchor));
}

/** Finds the project root for a path: the nearest ancestor containing `.git`, else `fallback`. */
export function findProjectRoot(startDir: string, fallback: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fallback;
}

/** Caches one {@link Project} per root directory. */
export class ProjectRegistry {
  private readonly projects = new Map<string, Project>();
  private readonly rootCache = new Map<string, string>();
  private fallbackRoots: string[];

  constructor(private readonly cwd: string) {
    this.fallbackRoots = [cwd];
  }

  /** Use the outermost containing scan directory when there is no Git root. */
  setScanDirectories(directories: readonly string[]): void {
    this.fallbackRoots = [this.cwd, ...directories].toSorted((a, b) => a.length - b.length);
    this.rootCache.clear();
  }

  forDirectory(dir: string): Project {
    let root = this.rootCache.get(dir);
    if (!root) {
      const fallback = this.fallbackRoots.find((base) => isWithin(base, dir)) ?? dir;
      root = findProjectRoot(dir, fallback);
      this.rootCache.set(dir, root);
    }
    let project = this.projects.get(root);
    if (!project) {
      project = new Project(root);
      this.projects.set(root, project);
    }
    return project;
  }
}
