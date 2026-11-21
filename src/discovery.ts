import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { matchesFilePattern } from "./config.ts";
import type { PatternIgnore } from "./gitignore.ts";
import { ALWAYS_SKIPPED_DIRS, type ProjectRegistry } from "./project.ts";

export interface DiscoverOptions {
  cwd: string;
  /** Files or directories to lint (relative to cwd). */
  paths: string[];
  /** Patterns selecting context files during directory traversal. */
  filePatterns: string[];
  /** Base directory for `filePatterns` containing a slash. */
  patternBase: string;
  /** Explicit ignore patterns (config `ignorePatterns`, `--ignore-pattern`, ignore file). */
  ignores: PatternIgnore[];
  /** Disables all ignore handling (.gitignore and explicit patterns). */
  noIgnore: boolean;
  registry: ProjectRegistry;
}

export interface DiscoveryResult {
  /** Absolute paths of files to lint, sorted. */
  files: string[];
  /** Explicitly named files excluded by a configured ignore pattern. */
  ignoredFiles: string[];
  /** Input paths that don't exist. */
  missing: string[];
  /** Directory paths that could not be listed and their filesystem error codes. */
  unreadableDirectories: Map<string, string>;
}

export function discoverFiles(options: DiscoverOptions): DiscoveryResult {
  const files = new Set<string>();
  const ignoredFiles = new Set<string>();
  const missing: string[] = [];
  const unreadableDirectories = new Map<string, string>();
  const explicitlyIgnored = (abs: string, isDir: boolean) =>
    !options.noIgnore && options.ignores.some((ig) => ig.isIgnored(abs, isDir));
  const isContextFile = (abs: string) =>
    options.filePatterns.some((pattern) => matchesFilePattern(pattern, options.patternBase, abs));

  const walk = (dir: string) => {
    const project = options.registry.forDirectory(dir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      unreadableDirectories.set(dir, (error as NodeJS.ErrnoException).code ?? "unknown error");
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let isDir = entry.isDirectory();
      const isLink = entry.isSymbolicLink();
      if (isLink) {
        try {
          isDir = statSync(abs).isDirectory();
        } catch {
          isDir = false; // broken symlink: treat as a file so it gets reported
        }
      }
      if (isDir && ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;
      if (!options.noIgnore && project.gitignore.isEntryIgnored(abs, isDir)) continue;
      if (explicitlyIgnored(abs, isDir)) continue;
      if (isDir) {
        // Symlinked directories are not followed (avoids cycles and duplicates).
        if (!isLink) walk(abs);
      } else if (isContextFile(abs)) {
        files.add(abs);
      }
    }
  };

  const directories = new Set<string>();
  for (const input of options.paths.length ? options.paths : ["."]) {
    const abs = resolve(options.cwd, input);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      missing.push(input);
      continue;
    }
    if (isDir) {
      if (!explicitlyIgnored(abs, true)) directories.add(abs);
    } else if (explicitlyIgnored(abs, false)) {
      ignoredFiles.add(abs);
    } else {
      // Explicitly named files bypass discovery patterns and .gitignore.
      files.add(abs);
    }
  }
  options.registry.setScanDirectories([...directories]);
  for (const dir of directories) walk(dir);
  return {
    files: [...files].toSorted(),
    ignoredFiles: [...ignoredFiles].toSorted(),
    missing,
    unreadableDirectories,
  };
}
