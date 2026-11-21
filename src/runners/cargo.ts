import { dirname, join, relative, resolve } from "node:path";

import { toPosix } from "#src/gitignore.ts";
import type { Project } from "#src/project.ts";
import { asRecord as rec } from "#src/util.ts";

import { readToml } from "./python.ts";
import type { Problem, TaskRunner } from "./types.ts";
import { display, flagValue, notDefined, parseArgs } from "./util.ts";

interface CrateTargets {
  name: string;
  dir: string;
  bins: Set<string>;
  examples: Set<string>;
  tests: Set<string>;
  benches: Set<string>;
}

/** Explicit `[[bin]]`-style targets plus auto-discovered ones (`src/bin/NAME.rs`, `examples/NAME/main.rs`, …). */
function targetsOf(project: Project, manifest: string, data: Record<string, unknown>): CrateTargets | null {
  const pkg = rec(data.package);
  if (typeof pkg.name !== "string") return null;
  const dir = dirname(manifest);
  const declaredPaths = (section: string) =>
    Array.isArray(data[section]) ? (data[section] as unknown[]).map((t) => rec(t).path).filter(Boolean) : [];
  const collect = (section: string, autoDir: string, defaults: string[] = []) => {
    const names = new Set(defaults);
    const declared = data[section];
    if (Array.isArray(declared))
      for (const t of declared) if (typeof rec(t).name === "string") names.add(rec(t).name as string);
    if (pkg[`auto${section}s`] === false) return names;
    for (const entry of project.readDir(join(dir, autoDir)) ?? []) {
      if (entry.endsWith(".rs")) names.add(entry.slice(0, -3));
      else if (project.isFile(join(dir, autoDir, entry, "main.rs"))) names.add(entry);
    }
    return names;
  };
  return {
    name: pkg.name,
    dir,
    // src/main.rs is the default binary unless an explicit [[bin]] already uses it.
    bins: collect(
      "bin",
      "src/bin",
      project.isFile(join(dir, "src", "main.rs")) && !declaredPaths("bin").includes("src/main.rs") ? [pkg.name] : [],
    ),
    examples: collect("example", "examples"),
    tests: collect("test", "tests"),
    benches: collect("bench", "benches"),
  };
}

interface CargoWorkspace {
  root: string;
  crates: CrateTargets[];
}

/** The workspace (or single crate) a manifest belongs to. */
function cargoWorkspace(project: Project, manifest: string): CargoWorkspace {
  // The workspace root is the nearest ancestor manifest with a [workspace] table.
  let rootManifest = manifest;
  for (const dir of project.ancestorsUpToRoot(dirname(manifest))) {
    const candidate = join(dir, "Cargo.toml");
    if (readToml(project, candidate)?.workspace) {
      rootManifest = candidate;
      break;
    }
  }
  return project.memo(`cargo:${rootManifest}`, () => {
    const data = readToml(project, rootManifest) ?? {};
    const root = dirname(rootManifest);
    const crates: CrateTargets[] = [];
    const own = targetsOf(project, rootManifest, data);
    if (own) crates.push(own);
    const ws = rec(data.workspace);
    const members = Array.isArray(ws.members) ? ws.members.filter((m): m is string => typeof m === "string") : [];
    const exclude = Array.isArray(ws.exclude) ? ws.exclude.filter((m): m is string => typeof m === "string") : [];
    const globs = members.map((m) => new Bun.Glob(m.replace(/\/+$/, "")));
    const excluded = exclude.map((m) => resolve(root, m));
    for (const file of project.findFilesNamed(["Cargo.toml"])) {
      const rel = toPosix(relative(root, dirname(file)));
      if (!rel || rel.startsWith("..") || !globs.some((g) => g.match(rel))) continue;
      if (excluded.some((e) => dirname(file) === e || dirname(file).startsWith(`${e}/`))) continue;
      const crate = targetsOf(project, file, readToml(project, file) ?? {});
      if (crate) crates.push(crate);
    }
    crates.sort((a, b) => a.name.localeCompare(b.name));
    return { root, crates };
  });
}

const SKIP_SUBCOMMANDS = new Set([
  "install",
  "uninstall",
  "search",
  "new",
  "init",
  "login",
  "logout",
  "owner",
  "yank",
  "help",
  "version",
]);

/** `cargo`: `-p` packages and `--bin` / `--example` / `--test` / `--bench` targets must exist. */
export const cargoRunner: TaskRunner = {
  id: "cargo",
  executables: ["cargo"],
  check(args, ctx) {
    const { project } = ctx;
    const tokens = args.slice(1).filter((t) => !t.value.startsWith("+")); // toolchain: cargo +nightly
    const parsed = parseArgs(tokens, {
      valued: [
        "-p",
        "--package",
        "--bin",
        "--example",
        "--test",
        "--bench",
        "--manifest-path",
        "--exclude",
        "-F",
        "--features",
        "--target",
        "--target-dir",
        "--profile",
        "-j",
        "--jobs",
        "--color",
        "--config",
        "-Z",
        "--message-format",
        "-C",
      ],
    });
    const subcommand = parsed.positionals[0];
    if (!subcommand || SKIP_SUBCOMMANDS.has(subcommand.value)) return [];
    const wanted = (name: string) => parsed.flags.filter((f) => f.name === name).flatMap((f) => f.values);
    const packages = [...wanted("-p"), ...wanted("--package")];
    const targetFlags = ["--bin", "--example", "--test", "--bench"] as const;
    if (!packages.length && !targetFlags.some((f) => wanted(f).length)) return [];

    const manifestFlag = flagValue(parsed, "--manifest-path");
    const manifest = manifestFlag
      ? project.resolveExisting(ctx.cwd, manifestFlag.value, "file")
      : project.findUp(ctx.cwd, ["Cargo.toml"]);
    if (!manifest || !project.isFile(manifest)) {
      return [{ token: subcommand, message: "No Cargo.toml found" }];
    }
    const ws = cargoWorkspace(project, manifest);
    const where = `the workspace at \`${display(project, join(ws.root, "Cargo.toml"))}\``;
    const problems: Problem[] = [];

    const selected: CrateTargets[] = [];
    for (const spec of packages) {
      const name = spec.value.replace(/[@:].*$/, "");
      const matches = /[*?[]/.test(name)
        ? ws.crates.filter((c) => new Bun.Glob(name).match(c.name))
        : ws.crates.filter((c) => c.name === name);
      if (matches.length) selected.push(...matches);
      else
        problems.push(
          notDefined(
            "Cargo package",
            name,
            spec,
            where,
            ws.crates.map((c) => c.name),
          ),
        );
    }
    if (packages.length && !selected.length) return problems;
    // Without -p: the crate of the current manifest, or every member for a virtual workspace.
    const scope = selected.length
      ? selected
      : ws.crates.filter((c) => c.dir === dirname(manifest)).length
        ? ws.crates.filter((c) => c.dir === dirname(manifest))
        : ws.crates;

    const kinds: Record<(typeof targetFlags)[number], { label: string; key: keyof CrateTargets }> = {
      "--bin": { label: "Binary", key: "bins" },
      "--example": { label: "Example", key: "examples" },
      "--test": { label: "Integration test", key: "tests" },
      "--bench": { label: "Benchmark", key: "benches" },
    };
    for (const flag of targetFlags) {
      const { label, key } = kinds[flag];
      for (const target of wanted(flag)) {
        if (!target.value || /[*?[]/.test(target.value)) continue;
        const available = scope.flatMap((c) => [...(c[key] as Set<string>)]);
        if (available.includes(target.value)) continue;
        const crateNames = scope.map((c) => `\`${c.name}\``).join(", ");
        problems.push(
          notDefined(
            label,
            target.value,
            target,
            scope.length === 1 ? `crate ${crateNames}` : `crates ${crateNames}`,
            available,
          ),
        );
      }
    }
    return problems;
  },
};
