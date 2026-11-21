import { dirname, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import type { Project } from "#src/project.ts";
import { sliceToken, type Token } from "#src/shell.ts";
import { asRecord as rec, asStrings as strings } from "#src/util.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, flagValue, hasFlag, notDefined, parseArgs } from "./util.ts";

type Rec = Record<string, unknown>;

export interface PyProject {
  file: string;
  dir: string;
  data: Rec;
}

/** Parses a TOML file (cached). */
export function readToml(project: Project, file: string): Rec | null {
  return project.memo(`toml:${file}`, () => {
    const text = project.readText(file);
    if (text === null) return null;
    try {
      return rec(parseToml(text));
    } catch {
      return null;
    }
  });
}

export function pyproject(project: Project, file: string): PyProject | null {
  const data = readToml(project, file);
  return data ? { file, dir: dirname(file), data } : null;
}

/** The nearest pyproject.toml at or above `dir`. */
export function pyprojectFor(project: Project, dir: string): PyProject | null {
  const file = project.findUp(dir, ["pyproject.toml"]);
  return file ? pyproject(project, file) : null;
}

/** Normalizes a distribution name (PEP 503). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function requirementName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? normalizeName(m[1] as string) : null;
}

/** All dependency names declared by a pyproject (all tools and groups) and requirements files. */
export function pythonDependencies(project: Project, py: PyProject): Set<string> {
  return project.memo(`py-deps:${py.file}`, () => {
    const deps = new Set<string>();
    const addSpecs = (specs: unknown) => {
      for (const spec of strings(specs)) {
        const name = requirementName(spec);
        if (name) deps.add(name);
      }
    };
    const addKeys = (table: unknown) => {
      for (const key of Object.keys(rec(table))) deps.add(normalizeName(key));
    };
    const { data } = py;
    const proj = rec(data.project);
    const tool = rec(data.tool);
    addSpecs(proj.dependencies);
    for (const group of Object.values(rec(proj["optional-dependencies"]))) addSpecs(group);
    for (const group of Object.values(rec(data["dependency-groups"]))) addSpecs(group);
    const poetry = rec(tool.poetry);
    addKeys(poetry.dependencies);
    addKeys(poetry["dev-dependencies"]);
    for (const group of Object.values(rec(poetry.group))) addKeys(rec(group).dependencies);
    for (const group of Object.values(rec(rec(tool.pdm)["dev-dependencies"]))) addSpecs(group);
    addSpecs(rec(tool.uv)["dev-dependencies"]);
    addSpecs(rec(tool.rye)["dev-dependencies"]);
    for (const env of Object.values(rec(rec(tool.hatch).envs))) {
      addSpecs(rec(env).dependencies);
      addSpecs(rec(env)["extra-dependencies"]);
    }
    const requirementFiles = (project.readDir(py.dir) ?? []).filter((f) =>
      /^(?:.*-)?requirements(?:-.*)?\.txt$/.test(f),
    );
    for (const f of requirementFiles) {
      for (const line of (project.readText(join(py.dir, f)) ?? "").split(/\r?\n/)) {
        if (!line.trim().startsWith("-") && !line.trim().startsWith("#")) addSpecs([line]);
      }
    }
    return deps;
  });
}

/** Console scripts installed by the project itself. */
export function entryPoints(py: PyProject): string[] {
  const proj = rec(py.data.project);
  return [
    ...Object.keys(rec(proj.scripts)),
    ...Object.keys(rec(proj["gui-scripts"])),
    ...Object.keys(rec(rec(rec(py.data.tool).poetry).scripts)),
  ];
}

/** Executables whose distribution has a different name. */
const KNOWN_BINS: Record<string, string[]> = {
  "py.test": ["pytest"],
  "django-admin": ["django"],
  jupyter: ["jupyter", "notebook", "jupyterlab", "jupyter-core"],
  "jupyter-lab": ["jupyterlab"],
  "sphinx-build": ["sphinx"],
  "sphinx-autobuild": ["sphinx-autobuild"],
  airflow: ["apache-airflow"],
  inv: ["invoke"],
  poe: ["poethepoet"],
  task: ["taskipy"],
  dmypy: ["mypy"],
  stubgen: ["mypy"],
  "datamodel-codegen": ["datamodel-code-generator"],
  fastapi: ["fastapi", "fastapi-cli"],
  cython: ["cython"],
  "pre-commit": ["pre-commit"],
  "pip-compile": ["pip-tools"],
  "pip-sync": ["pip-tools"],
  pyright: ["pyright", "basedpyright"],
  playwright: ["playwright", "pytest-playwright"],
  ipython: ["ipython"],
  streamlit: ["streamlit"],
};

/** Commands that exist in any Python environment (or on any dev machine). */
const ALWAYS_AVAILABLE = new Set([
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "bash",
  "sh",
  "zsh",
  "env",
  "echo",
  "which",
  "ls",
  "cat",
  "git",
  "node",
  "npm",
  "npx",
  "uv",
  "uvx",
  "poetry",
  "pdm",
  "hatch",
  "rye",
  "pipenv",
]);

/** Whether `name` can be run inside the project's environment. */
function commandAvailable(project: Project, py: PyProject, name: string, extraDeps: Set<string> = new Set()): boolean {
  if (name.includes("/") || /\.(?:py|sh|ps1)$/.test(name) || ALWAYS_AVAILABLE.has(name)) return true;
  if (entryPoints(py).includes(name)) return true;
  const deps = pythonDependencies(project, py);
  const providers = [name, ...(KNOWN_BINS[name] ?? [])].map(normalizeName);
  if (providers.some((p) => deps.has(p) || extraDeps.has(p))) return true;
  for (const dir of project.ancestorsUpToRoot(py.dir)) {
    for (const venv of [".venv", "venv"]) {
      if (project.exists(join(dir, venv, "bin", name)) || project.exists(join(dir, venv, "Scripts", `${name}.exe`))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks the target of `<tool> run <name>`: a script defined for the tool, a
 * nested task-runner command, or a command provided by the environment.
 */
function checkRunTarget(
  tool: string,
  args: Token[],
  ctx: RunnerContext,
  py: PyProject,
  scripts: string[],
  {
    configFile = py.file,
    extraDeps,
    nestedCwd = py.dir,
  }: { configFile?: string; extraDeps?: Set<string>; nestedCwd?: string } = {},
): Problem[] {
  const cmd = args[0];
  if (!cmd || scripts.includes(cmd.value)) return [];
  const nested = ctx.checkNested(args, nestedCwd);
  if (nested) return nested;
  if (commandAvailable(ctx.project, py, cmd.value, extraDeps)) return [];
  const problem = notDefined(`${tool} script`, cmd.value, cmd, `\`${display(ctx.project, configFile)}\``, scripts);
  return [
    {
      ...problem,
      message: `${problem.message}, and no dependency provides a \`${cmd.value}\` command`,
    },
  ];
}

function dirFrom(ctx: RunnerContext, ...values: (Token | undefined)[]): string {
  const value = values.find(Boolean);
  return value ? ctx.project.resolveExisting(ctx.cwd, value.value, "dir") : ctx.cwd;
}

/** `poetry run <cmd>` and `poetry poe <task>`. */
export const poetryRunner: TaskRunner = {
  id: "poetry",
  executables: ["poetry"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), {
      valued: ["-C", "--directory", "-P", "--project"],
      stopAtPositional: true,
    });
    const [sub, ...rest] = parsed.positionals;
    const dir = dirFrom(ctx, flagValue(parsed, "-C", "--directory"), flagValue(parsed, "-P", "--project"));
    if (sub?.value === "poe") return ctx.checkNested([sub, ...rest], dir) ?? [];
    if (sub?.value !== "run") return [];
    const py = pyprojectFor(ctx.project, dir);
    return py ? checkRunTarget("Poetry", rest[0]?.value === "--" ? rest.slice(1) : rest, ctx, py, entryPoints(py)) : [];
  },
};

const UV_VALUED = [
  "--directory",
  "--project",
  "--cache-dir",
  "--config-file",
  "--color",
  "--python-preference",
  "--with",
  "--with-editable",
  "--with-requirements",
  "--package",
  "--extra",
  "--group",
  "--only-group",
  "--no-group",
  "--python",
  "-p",
  "--env-file",
  "--index",
  "--default-index",
  "--index-url",
  "--extra-index-url",
  "--find-links",
  "-f",
  "--index-strategy",
  "--resolution",
  "--prerelease",
  "--refresh-package",
  "--reinstall-package",
  "--upgrade-package",
  "-P",
  "--exclude-newer",
  "--link-mode",
  "--compile-bytecode",
];

/** `uv run <cmd>`. */
export const uvRunner: TaskRunner = {
  id: "uv",
  executables: ["uv"],
  check(args, ctx) {
    const global = parseArgs(args.slice(1), { valued: UV_VALUED, stopAtPositional: true });
    const [sub, ...rest] = global.positionals;
    if (sub?.value !== "run") return [];
    const run = parseArgs(rest, { valued: UV_VALUED, stopAtPositional: true });
    const parsed = { flags: [...global.flags, ...run.flags], positionals: run.positionals };
    const adHoc = [
      "--with",
      "--with-editable",
      "--with-requirements",
      "--no-project",
      "--script",
      "-m",
      "--module",
      "--gui-script",
      "-s",
    ];
    if (hasFlag(parsed, ...adHoc)) return [];
    const cwd = dirFrom(ctx, flagValue(parsed, "--directory"));
    const projectFlag = flagValue(parsed, "--project");
    const projectDir = projectFlag ? ctx.project.resolveExisting(cwd, projectFlag.value, "dir") : cwd;
    const py = pyprojectFor(ctx.project, projectDir);
    if (!py) return [];
    let scripts = entryPoints(py);
    let extraDeps: Set<string> | undefined;
    if (hasFlag(parsed, "--package", "--all-packages")) {
      // Workspace members: accept anything any member provides.
      const members = ctx.project
        .findFilesNamed(["pyproject.toml"])
        .map((f) => pyproject(ctx.project, f))
        .filter((p): p is PyProject => !!p);
      scripts = members.flatMap(entryPoints);
      extraDeps = new Set(members.flatMap((m) => Array.from(pythonDependencies(ctx.project, m))));
    }
    return checkRunTarget("uv", parsed.positionals, ctx, py, scripts, { extraDeps, nestedCwd: cwd });
  },
};

/** `pdm run <script|cmd>` with `[tool.pdm.scripts]`. */
export const pdmRunner: TaskRunner = {
  id: "pdm",
  executables: ["pdm"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), { valued: ["-p", "--project", "--venv"], stopAtPositional: true });
    const [sub, ...rest] = parsed.positionals;
    if (sub?.value !== "run") return [];
    const run = parseArgs(rest, { valued: ["-p", "--project", "--venv"], stopAtPositional: true });
    if (hasFlag(run, "-l", "--list", "-g", "--global")) return [];
    const py = pyprojectFor(
      ctx.project,
      dirFrom(ctx, flagValue(run, "-p", "--project"), flagValue(parsed, "-p", "--project")),
    );
    if (!py) return [];
    const scripts = Object.keys(rec(rec(rec(py.data.tool).pdm).scripts)).filter((s) => s !== "_");
    return checkRunTarget("PDM", run.positionals, ctx, py, [...scripts, ...entryPoints(py)]);
  },
};

/** `rye run <script|cmd>` with `[tool.rye.scripts]`. */
export const ryeRunner: TaskRunner = {
  id: "rye",
  executables: ["rye"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), { valued: ["--pyproject"], stopAtPositional: true });
    const [sub, ...rest] = parsed.positionals;
    if (sub?.value !== "run") return [];
    const run = parseArgs(rest, { valued: ["--pyproject"], stopAtPositional: true });
    if (hasFlag(run, "-l", "--list")) return [];
    const file = flagValue(run, "--pyproject");
    const py = file
      ? pyproject(ctx.project, ctx.project.resolveExisting(ctx.cwd, file.value, "file"))
      : pyprojectFor(ctx.project, ctx.cwd);
    if (!py) return [];
    const scripts = Object.keys(rec(rec(rec(py.data.tool).rye).scripts));
    return checkRunTarget("Rye", run.positionals, ctx, py, [...scripts, ...entryPoints(py)]);
  },
};

/** `hatch run [env:]<script|cmd>` with `[tool.hatch.envs.<env>.scripts]` (or hatch.toml). */
export const hatchRunner: TaskRunner = {
  id: "hatch",
  executables: ["hatch"],
  check(args, ctx) {
    const valued = ["-e", "--env", "-p", "--project", "--data-dir", "--cache-dir", "--config"];
    const parsed = parseArgs(args.slice(1), { valued, stopAtPositional: true });
    const [sub, ...rest] = parsed.positionals;
    if (sub?.value !== "run") return [];
    const run = parseArgs(rest, { stopAtPositional: true });
    const target = run.positionals[0];
    if (!target) return [];
    const py = pyprojectFor(ctx.project, ctx.cwd);
    if (!py) return [];
    const hatchToml = readToml(ctx.project, join(py.dir, "hatch.toml"));
    const envs = { ...rec(rec(rec(py.data.tool).hatch).envs), ...rec(hatchToml?.envs) };
    const colon = target.value.indexOf(":");
    const envName = (
      colon > 0 ? target.value.slice(0, colon) : (flagValue(parsed, "-e", "--env")?.value ?? "default")
    ).split(".")[0] as string; // matrix suffix: test.py3.12
    if (envName !== "default" && !(envName in envs)) return [];
    const scripts = [...Object.keys(rec(rec(envs[envName]).scripts)), ...Object.keys(rec(rec(envs.default).scripts))];
    const cmd = colon > 0 ? sliceToken(target, colon + 1) : target;
    const envDeps = new Set(
      [...strings(rec(envs[envName]).dependencies), ...strings(rec(envs[envName])["extra-dependencies"])]
        .map(requirementName)
        .filter((n): n is string => !!n),
    );
    return checkRunTarget("Hatch", [cmd, ...run.positionals.slice(1)], ctx, py, scripts, {
      configFile: hatchToml ? join(py.dir, "hatch.toml") : py.file,
      extraDeps: envDeps,
    });
  },
};

/** `pipenv run <script|cmd>` with Pipfile `[scripts]`. */
export const pipenvRunner: TaskRunner = {
  id: "pipenv",
  executables: ["pipenv"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), { stopAtPositional: true });
    const [sub, ...rest] = parsed.positionals;
    if (sub?.value !== "run") return [];
    const file = ctx.project.findUp(ctx.cwd, ["Pipfile"]);
    const pipfile = file ? readToml(ctx.project, file) : null;
    if (!file || !pipfile) return [];
    const deps = new Set(
      [...Object.keys(rec(pipfile.packages)), ...Object.keys(rec(pipfile["dev-packages"]))].map(normalizeName),
    );
    const py: PyProject = pyprojectFor(ctx.project, dirname(file)) ?? { file, dir: dirname(file), data: {} };
    return checkRunTarget("Pipenv", rest, ctx, py, Object.keys(rec(pipfile.scripts)), {
      configFile: file,
      extraDeps: deps,
    });
  },
};

/** poethepoet: `poe <task>` with `[tool.poe.tasks]`. */
export const poeRunner: TaskRunner = {
  id: "poe",
  executables: ["poe"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), {
      valued: ["-C", "--directory", "--root", "-e", "--executor"],
      stopAtPositional: true,
    });
    if (hasFlag(parsed, "-h", "--help", "--version")) return [];
    const task = parsed.positionals[0];
    if (!task) return [];
    const py = pyprojectFor(ctx.project, dirFrom(ctx, flagValue(parsed, "-C", "--directory", "--root")));
    if (!py) return [];
    const poe = rec(rec(py.data.tool).poe);
    if (poe.include !== undefined) return []; // tasks from other files
    const tasks = Object.keys(rec(poe.tasks));
    return tasks.includes(task.value)
      ? []
      : [notDefined("Poe task", task.value, task, `\`${display(ctx.project, py.file)}\``, tasks)];
  },
};

// ---------------------------------------------------------------- tox

/** Expands tox generative names: `py{39,310}-django{4,5}`, `py3{10-12}`. */
export function expandGenerative(name: string): string[] {
  const m = /\{([^{}]*)\}/.exec(name);
  if (!m) return [name];
  const options = (m[1] as string).split(",").flatMap((opt) => {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(opt);
    if (!range) return [opt.trim()];
    const out: string[] = [];
    for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(String(i));
    return out;
  });
  const before = name.slice(0, m.index);
  const after = name.slice(m.index + m[0].length);
  return options.flatMap((opt) => expandGenerative(`${before}${opt}${after}`));
}

function splitEnvList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if ((ch === "," || ch === "\n") && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let lastKey: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line) || !line.trim()) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = new Map();
      sections.set((header[1] as string).trim(), section);
      lastKey = undefined;
    } else if (/^\s/.test(line) && section && lastKey) {
      section.set(lastKey, `${section.get(lastKey)}\n${line.trim()}`);
    } else if (section) {
      const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
      if (kv) {
        lastKey = (kv[1] as string).trim();
        section.set(lastKey, (kv[2] as string).trim());
      }
    }
  }
  return sections;
}

/** Environment names defined by tox.ini, setup.cfg, tox.toml or pyproject.toml (null when there is no tox config). */
export function toxEnvironments(project: Project, dir: string): { envs: Set<string>; file: string } | null {
  const envs = new Set<string>();
  const addNames = (names: string[]) => {
    for (const n of names) for (const e of expandGenerative(n)) envs.add(e);
  };
  const fromIni = (text: string, mainSection: string) => {
    const ini = parseIni(text);
    const main = ini.get(mainSection);
    addNames(splitEnvList(main?.get("envlist") ?? main?.get("env_list") ?? ""));
    for (const name of ini.keys()) if (name.startsWith("testenv:")) addNames([name.slice(8)]);
  };
  const toxIni = project.findUp(dir, ["tox.ini"]);
  if (toxIni) {
    fromIni(project.readText(toxIni) ?? "", "tox");
    return { envs, file: toxIni };
  }
  const toxToml = project.findUp(dir, ["tox.toml"]);
  const pyprojectToml = project.findUp(dir, ["pyproject.toml"]);
  const native = toxToml
    ? readToml(project, toxToml)
    : rec(rec(pyprojectToml ? readToml(project, pyprojectToml)?.tool : null).tox);
  if (native && Object.keys(native).length) {
    if (typeof native.legacy_tox_ini === "string") {
      fromIni(native.legacy_tox_ini, "tox");
    } else {
      addNames(strings(native.env_list));
      addNames(Object.keys(rec(native.env)));
    }
    return { envs, file: (toxToml ?? pyprojectToml) as string };
  }
  const setupCfg = project.findUp(dir, ["setup.cfg"]);
  const setupText = setupCfg ? (project.readText(setupCfg) ?? "") : "";
  if (setupCfg && /^\[tox:tox\]/m.test(setupText)) {
    fromIni(setupText, "tox:tox");
    return { envs, file: setupCfg };
  }
  return null;
}

const PY_FACTOR = /^(?:py|pypy|cpython|jython)\d*(?:\.\d+)?t?$/;

export const toxRunner: TaskRunner = {
  id: "tox",
  executables: ["tox"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), {
      valued: [
        "-e",
        "--env",
        "-c",
        "--conf",
        "--root",
        "--workdir",
        "-m",
        "-f",
        "-x",
        "--override",
        "-p",
        "--parallel",
        "--installpkg",
        "--result-json",
      ],
    });
    const requested = parsed.flags
      .filter((f) => f.name === "-e" || f.name === "--env")
      .flatMap((f) => f.values)
      .flatMap((t) => {
        let start = 0;
        return t.value.split(",").map((value) => {
          const token = sliceToken(t, start, start + value.length);
          start += value.length + 1;
          return token;
        });
      })
      .filter((t) => t.value && t.value !== "ALL");
    if (!requested.length) return [];
    const conf = flagValue(parsed, "-c", "--conf");
    const config = toxEnvironments(
      ctx.project,
      conf ? dirname(ctx.project.resolveExisting(ctx.cwd, conf.value, "file")) : ctx.cwd,
    );
    if (!config) return [];
    const factors = new Set([...config.envs].flatMap((e) => e.split("-")));
    return requested
      .filter((t) => !config.envs.has(t.value) && !t.value.split("-").every((f) => PY_FACTOR.test(f) || factors.has(f)))
      .map((t) => notDefined("tox environment", t.value, t, `\`${display(ctx.project, config.file)}\``, config.envs));
  },
};

// ---------------------------------------------------------------- nox

/** Session names declared with `@nox.session` / `@session` (null when they can't be determined). */
export function noxSessions(text: string): Set<string> | null {
  const sessions = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@(?:nox\.)?session\b/.test(lines[i] as string)) continue;
    let decorator = "";
    let j = i;
    for (; j < lines.length; j++) {
      const def = /^\s*(?:async\s+)?def\s+(\w+)/.exec(lines[j] as string);
      if (def) {
        const explicit = /\bname\s*=\s*["']([^"']+)["']/.exec(decorator);
        sessions.add(explicit ? (explicit[1] as string) : (def[1] as string));
        break;
      }
      decorator += `${lines[j]}\n`;
    }
    i = j;
  }
  if (sessions.size === 0 || /nox\.session\(\s*\w+\s*,/.test(text)) return null;
  return sessions;
}

export const noxRunner: TaskRunner = {
  id: "nox",
  executables: ["nox"],
  check(args, ctx) {
    const parsed = parseArgs(args.slice(1), {
      valued: [
        "-f",
        "--noxfile",
        "-p",
        "--python",
        "-t",
        "--tags",
        "-k",
        "--envdir",
        "--extra-python",
        "--force-python",
      ],
      multi: ["-s", "--session", "--sessions", "-e"],
    });
    const requested = parsed.flags
      .filter((f) => ["-s", "--session", "--sessions", "-e"].includes(f.name))
      .flatMap((f) => f.values);
    if (!requested.length) return [];
    const noxfileFlag = flagValue(parsed, "-f", "--noxfile");
    const file = noxfileFlag
      ? ctx.project.resolveExisting(ctx.cwd, noxfileFlag.value, "file")
      : ctx.project.findUp(ctx.cwd, ["noxfile.py"]);
    if (!file || !ctx.project.isFile(file)) {
      return [{ token: requested[0] as Token, name: requested[0]?.value, message: "No noxfile.py found" }];
    }
    const sessions = ctx.project.memo(`nox:${file}`, () => noxSessions(ctx.project.readText(file) ?? ""));
    if (!sessions) return [];
    return requested
      .filter((t) => {
        const base = t.value.replace(/\(.*\)$/, "").replace(/-(?:\d+(?:\.\d+)*t?|pypy[\d.]*)$/, "");
        return !sessions.has(t.value) && !sessions.has(base);
      })
      .map((t) => notDefined("Nox session", t.value, t, `\`${display(ctx.project, file)}\``, sessions));
  },
};

export const pythonRunners: TaskRunner[] = [
  poetryRunner,
  uvRunner,
  pdmRunner,
  ryeRunner,
  hatchRunner,
  pipenvRunner,
  poeRunner,
  toxRunner,
  noxRunner,
];
