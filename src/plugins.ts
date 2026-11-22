import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { BUILTIN } from "#src/rules/index.ts";

import type { Plugin } from "./types.ts";
import { isRecord } from "./util.ts";

/** A `jsPlugins` entry, as in Oxlint: a path or package name, or an object that gives the plugin a name. */
export type PluginEntry = string | { name: string; specifier: string };

/**
 * The name a plugin's rules are prefixed with, from its `meta.name` or package name, as in Oxlint:
 * `eslint-plugin-foo` → `foo`, `@scope/eslint-plugin` → `@scope`, `@scope/eslint-plugin-foo` → `@scope/foo`.
 * The same applies to `oxlint-plugin-`.
 */
export function normalizePluginName(name: string): string {
  const slash = name.indexOf("/");
  const scope = slash === -1 ? "" : name.slice(0, slash);
  const rest = name.slice(slash + 1);
  for (const prefix of ["eslint-plugin", "oxlint-plugin"]) {
    if (scope && rest === prefix) return scope;
    if (rest.startsWith(`${prefix}-`)) return (scope ? `${scope}/` : "") + rest.slice(prefix.length + 1);
  }
  return name;
}

/** The package a specifier imports from, or undefined for a path. */
function packageName(specifier: string): string | undefined {
  if (/^\.{0,2}[\\/]/.test(specifier) || specifier === "." || specifier === ".." || isAbsolute(specifier)) {
    return undefined;
  }
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

/** The conditions Node.js matches in `exports` when a package is imported (not required). */
const IMPORT_CONDITIONS = new Set(["node", "import", "module-sync", "default"]);

/** The path an `exports` target resolves to for {@link IMPORT_CONDITIONS}, or undefined. `*` is replaced by `wildcard`. */
function exportTarget(target: unknown, wildcard: string | undefined): string | undefined {
  if (typeof target === "string") return wildcard === undefined ? target : target.replaceAll("*", wildcard);
  const candidates = Array.isArray(target)
    ? target
    : isRecord(target)
      ? Object.entries(target).flatMap(([condition, value]) => (IMPORT_CONDITIONS.has(condition) ? [value] : []))
      : [];
  for (const candidate of candidates) {
    const path = exportTarget(candidate, wildcard);
    if (path !== undefined) return path;
  }
  return undefined;
}

/** The target of `subpath` (`.` or `./sub`) in a package's `exports`, including `*` patterns, or undefined. */
function resolveExports(exports: unknown, subpath: string): string | undefined {
  const subpaths =
    isRecord(exports) && Object.keys(exports).some((key) => key.startsWith(".")) ? exports : { ".": exports };
  if (Object.hasOwn(subpaths, subpath)) return exportTarget(subpaths[subpath], undefined);
  // As in Node.js, the pattern with the longest prefix wins.
  let best: { key: string; wildcard: string } | undefined;
  for (const key of Object.keys(subpaths)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.length < key.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (best && best.key.indexOf("*") >= star) continue;
    best = { key, wildcard: subpath.slice(star, subpath.length - suffix.length) };
  }
  return best && exportTarget(subpaths[best.key], best.wildcard);
}

/**
 * Resolves a package specifier with the `exports` conditions of `import()`, so that packages that
 * only export an `import` entry load. Returns undefined for anything else (no `exports`, or no
 * match), which `require.resolve` then handles.
 */
function resolvePackageImport(specifier: string, name: string, dir: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    const root = join(current, "node_modules", name);
    const manifest = join(root, "package.json");
    if (existsSync(manifest)) {
      let exports: unknown;
      try {
        exports = (JSON.parse(readFileSync(manifest, "utf8")) as { exports?: unknown }).exports;
      } catch {
        return undefined;
      }
      if (exports === undefined) return undefined;
      const target = resolveExports(exports, `.${specifier.slice(name.length)}`);
      if (!target?.startsWith("./")) return undefined;
      const path = join(root, target);
      return existsSync(path) ? realpathSync(path) : undefined;
    }
    if (dirname(current) === current) return undefined;
  }
}

/** Resolves a specifier like Oxlint: paths relative to `dir`, packages from the `node_modules` of `dir` and its ancestors. */
function resolveSpecifier(specifier: string, dir: string): string {
  const require = createRequire(join(dir, "noop.js"));
  const name = packageName(specifier);
  // `require.resolve` adds extensions and finds index files, which `import()` doesn't on Node.
  if (name === undefined) return require.resolve(resolve(dir, specifier));
  return resolvePackageImport(specifier, name, dir) ?? require.resolve(specifier);
}

const rename = (specifier: string) => `Name it in \`jsPlugins\`: { "name": "...", "specifier": "${specifier}" }`;

/** Imports the plugin of a `jsPlugins` entry and checks its shape. */
async function importPlugin(entry: PluginEntry, dir: string) {
  const { specifier, name } = typeof entry === "string" ? { specifier: entry, name: undefined } : entry;
  let path: string;
  let module: { default?: unknown };
  try {
    path = resolveSpecifier(specifier, dir);
    module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (error) {
    const reason = (error as Error).message.split("\n", 1)[0];
    throw new Error(`Cannot load plugin "${specifier}": ${reason}`, { cause: error });
  }
  const plugin = module.default;
  if (!isRecord(plugin) || !isRecord(plugin.rules)) {
    throw new Error(`Plugin "${specifier}" must export a plugin object with \`rules\` as its default export`);
  }
  if (plugin.meta !== undefined && !isRecord(plugin.meta)) {
    throw new Error(`Plugin "${specifier}" has an invalid \`meta\`: expected an object`);
  }
  if (plugin.meta?.name !== undefined && typeof plugin.meta.name !== "string") {
    throw new Error(`Plugin "${specifier}" has an invalid \`meta.name\`: expected a string. ${rename(specifier)}`);
  }
  for (const [rule, value] of Object.entries(plugin.rules)) {
    const hooks = isRecord(value) ? [value.create, value.createOnce, value.checkTree] : [];
    if (!hooks.some((hook) => typeof hook === "function")) {
      throw new Error(`Rule "${rule}" of plugin "${specifier}" has no \`create\` function`);
    }
  }
  return { specifier, name, path, plugin: plugin as Plugin };
}

/** Plugins by name, and the errors of entries that failed to load. */
export interface LoadedPlugins {
  plugins: Map<string, Plugin>;
  errors: Error[];
}

/**
 * Loads `jsPlugins` entries, resolved against `dir` (the config file's directory), as far as
 * possible. Returns the plugins that loaded by name (the entry's `name`, else the plugin's
 * `meta.name`, else its package name) and the errors of the others, in entry order.
 */
export async function loadPluginsSettled(entries: readonly PluginEntry[], dir: string): Promise<LoadedPlugins> {
  const results = await Promise.allSettled(entries.map((entry) => importPlugin(entry, dir)));
  const plugins = new Map<string, Plugin>();
  const errors: Error[] = [];
  const paths = new Map<string, string>([[BUILTIN, ""]]);
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason as Error);
      continue;
    }
    const { specifier, path, plugin, ...entry } = result.value;
    const fallback = plugin.meta?.name ?? packageName(specifier);
    const name = entry.name ?? (fallback && normalizePluginName(fallback));
    if (!name) {
      errors.push(new Error(`Plugin "${specifier}" has no \`meta.name\`. ${rename(specifier)}`));
    } else if (paths.has(name) && paths.get(name) !== path) {
      // The same plugin may be listed more than once, e.g. in several overrides.
      errors.push(new Error(`Plugin name "${name}" is already taken. ${rename(specifier)}`));
    } else {
      paths.set(name, path);
      plugins.set(name, plugin);
    }
  }
  return { plugins, errors };
}

/** Like {@link loadPluginsSettled}, but throws the first error. */
export async function loadPlugins(entries: readonly PluginEntry[], dir: string): Promise<Map<string, Plugin>> {
  const { plugins, errors } = await loadPluginsSettled(entries, dir);
  if (errors[0]) throw errors[0];
  return plugins;
}
