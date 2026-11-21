import { globSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";

import type { Problem, RunnerContext, TaskRunner } from "./types.ts";
import { display, notDefined } from "./util.ts";

export const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];

export interface MakefileInfo {
  targets: Set<string>;
  /** Pattern rules (`%.o: %.c`) as regular expressions. */
  patterns: RegExp[];
  /** Literal suffix lists in declaration order. An empty list clears the active suffixes. */
  suffixes: string[][];
  /** Whether some targets or includes are computed (`$(BIN):`), so unknown targets can't be ruled out. */
  dynamic: boolean;
}

const SPECIAL_TARGETS =
  /^\.(?:PHONY|SUFFIXES|DEFAULT|PRECIOUS|INTERMEDIATE|NOTINTERMEDIATE|SECONDARY|SECONDEXPANSION|DELETE_ON_ERROR|IGNORE|LOW_RESOLUTION_TIME|SILENT|EXPORT_ALL_VARIABLES|NOTPARALLEL|ONESHELL|POSIX)$/;
const ASSIGNMENT = /^(?:(?:export|override|private|unexport)\s+)*[^\s:#=]+\s*(?::{1,3}=|\?=|\+=|!=|=)/;
const DIRECTIVE = /^(?:ifeq|ifneq|ifdef|ifndef|else|endif|export|unexport|override|vpath|undefine)\b/;

/** Extracts the targets of a Makefile, following literal `include`s. */
export function parseMakefile(
  project: Project,
  file: string,
  cwd = dirname(file),
  seen = new Set<string>(),
): MakefileInfo {
  const info: MakefileInfo = { targets: new Set(), patterns: [], suffixes: [], dynamic: false };
  if (seen.has(file)) return info;
  seen.add(file);
  const text = project.readText(file);
  if (text === null) return info;
  let defineDepth = 0;
  for (const rawLine of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (/^\s*define\b/.test(rawLine)) {
      defineDepth++;
      continue;
    }
    if (defineDepth) {
      if (/^\s*endef\b/.test(rawLine)) defineDepth--;
      continue;
    }
    if (rawLine.startsWith("\t")) continue; // recipe line
    const line = rawLine.replace(/(^|[^\\])#.*$/, "$1").trim();
    if (!line) continue;

    const include = /^(?:-?include|sinclude)\s+(.+)$/.exec(line);
    if (include) {
      for (const pattern of (include[1] as string).split(/\s+/)) {
        if (/\$[({]/.test(pattern)) {
          info.dynamic = true;
          continue;
        }
        const matches = /[*?[]/.test(pattern)
          ? globSync(pattern, { cwd })
              .map((m) => resolve(cwd, m))
              .filter((path) => project.isFile(path))
          : [resolve(cwd, pattern)];
        for (const match of matches) {
          const nested = parseMakefile(project, match, cwd, seen);
          for (const t of nested.targets) info.targets.add(t);
          info.patterns.push(...nested.patterns);
          info.suffixes.push(...nested.suffixes);
          info.dynamic ||= nested.dynamic;
        }
      }
      continue;
    }
    if (ASSIGNMENT.test(line)) continue;
    const rule = /^([^:=#]+?)\s*(?:::?|&:)(?!=)(.*)$/.exec(line);
    if (!rule) {
      if (!DIRECTIVE.test(line) && /\$[({]/.test(line)) info.dynamic = true; // e.g. $(eval ...)
      continue;
    }
    for (const target of (rule[1] as string).split(/\s+/)) {
      if (!target) continue;
      if (/\$[({]/.test(target)) {
        info.dynamic = true;
      } else if (SPECIAL_TARGETS.test(target)) {
        if (target === ".PHONY") {
          for (const dep of (rule[2] as string).split(/[\s;|]+/)) if (dep && !/\$[({]/.test(dep)) info.targets.add(dep);
        } else if (target === ".SUFFIXES") {
          const suffixes = (rule[2] as string).split(";")[0]?.trim() ?? "";
          if (/\$[({]/.test(suffixes)) info.dynamic = true;
          else info.suffixes.push(suffixes ? suffixes.split(/\s+/) : []);
        }
      } else if (target.includes("%")) {
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("%", ".+");
        info.patterns.push(new RegExp(`^${escaped}$`));
      } else {
        info.targets.add(target);
      }
    }
  }
  return info;
}

function makefileInfo(project: Project, files: string[], cwd: string): MakefileInfo {
  return project.memo(`make:${cwd}\0${files.join("\0")}`, () => {
    const merged: MakefileInfo = { targets: new Set(), patterns: [], suffixes: [], dynamic: false };
    for (const file of files) {
      const info = parseMakefile(project, file, cwd);
      for (const t of info.targets) merged.targets.add(t);
      merged.patterns.push(...info.patterns);
      merged.suffixes.push(...info.suffixes);
      merged.dynamic ||= info.dynamic;
    }
    return merged;
  });
}

function definesTarget(info: MakefileInfo, target: string): boolean {
  return info.targets.has(target) || info.patterns.some((p) => p.test(target));
}

const COMPILE_SUFFIXES = [".c", ".cc", ".C", ".cpp", ".m", ".p", ".f", ".F", ".r", ".s", ".S", ".mod"];
const LINK_SUFFIXES = [...COMPILE_SUFFIXES, ".o", ".sh"];

function hasImplicitSource(project: Project, target: string, suffixLists: string[][]): boolean {
  const outputSuffix = extname(target);
  const sources = outputSuffix === ".o" ? COMPILE_SUFFIXES : outputSuffix === "" ? LINK_SUFFIXES : [];
  const stem = outputSuffix ? target.slice(0, -outputSuffix.length) : target;
  const active = (suffix: string) => {
    const last = suffixLists.findLast((list) => !list.length || list.includes(suffix));
    return last === undefined || last.length > 0;
  };
  if (outputSuffix && !active(outputSuffix)) return false;
  return sources.some((suffix) => active(suffix) && project.isFile(stem + suffix));
}

export const makeRunner: TaskRunner = {
  id: "make",
  executables: ["make", "gmake"],
  check(args: Token[], ctx: RunnerContext): Problem[] {
    const { project } = ctx;
    let dir = ctx.cwd;
    let allowBuiltins = true;
    const makefileArgs: string[] = [];
    const targets: Token[] = [];
    for (let i = 1; i < args.length; i++) {
      const v = (args[i] as Token).value;
      const next = args[i + 1]?.value;
      if (v === "--") break;
      if (["-h", "--help", "-v", "--version"].includes(v)) return [];
      if (
        v === "--no-builtin-rules" ||
        v === "--no-builtin-variables" ||
        (/^-[BdeiknqrRstSw]+$/.test(v) && /[rR]/.test(v))
      ) {
        allowBuiltins = false;
      } else if (v === "-C" || v === "--directory") {
        if (next) dir = project.resolveExisting(dir, next, "dir");
        i++;
      } else if (v.startsWith("--directory=")) {
        dir = project.resolveExisting(dir, v.slice(12), "dir");
      } else if (v.startsWith("-C")) {
        dir = project.resolveExisting(dir, v.slice(2), "dir");
      } else if (v === "-f" || v === "--file" || v === "--makefile") {
        if (next) makefileArgs.push(next);
        i++;
      } else if (/^--(?:file|makefile)=/.test(v)) {
        makefileArgs.push(v.slice(v.indexOf("=") + 1));
      } else if (v.startsWith("-f") && v.length > 2) {
        makefileArgs.push(v.slice(2));
      } else if (/^(?:-[IoW]|--(?:include-dir|old-file|assume-old|what-if|new-file|assume-new))$/.test(v)) {
        i++;
      } else if (/^(?:-[jl]|--jobs|--load-average|--max-load)$/.test(v)) {
        if (next && /^\d+(\.\d+)?$/.test(next)) i++;
      } else if (v.startsWith("-")) {
        // boolean flags (-s, -k, -n, -j4, ...)
      } else if (/^[A-Za-z_][\w.-]*\s*(?::{1,3}|\+|\?|!)?=/.test(v)) {
        // variable assignment: make VAR=value target
      } else {
        targets.push(args[i] as Token);
      }
    }

    const executable = args[0] as Token;
    let files: string[];
    let makeDir = dir;
    if (makefileArgs.length) {
      files = makefileArgs.map((f) => resolve(dir, f));
      const missing = files.find((f) => !project.isFile(f));
      if (missing) return [{ token: executable, message: `Makefile \`${display(project, missing)}\` does not exist` }];
    } else {
      const found = project.findUp(dir, MAKEFILE_NAMES);
      if (!found) {
        const unresolved = targets.filter((t) => {
          const path = resolve(dir, t.value);
          return !project.exists(path) && !(allowBuiltins && hasImplicitSource(project, path, []));
        });
        if (targets.length && !unresolved.length) return [];
        const elsewhere = project.findFilesNamed(MAKEFILE_NAMES);
        if (
          elsewhere.length &&
          unresolved.every((t) => elsewhere.some((f) => definesTarget(makefileInfo(project, [f], dirname(f)), t.value)))
        ) {
          return [];
        }
        return [
          {
            token: unresolved[0] ?? executable,
            name: unresolved[0]?.value,
            message: `No Makefile found for \`make${targets.length ? ` ${targets.map((t) => t.value).join(" ")}` : ""}\``,
          },
        ];
      }
      files = [found];
      makeDir = dirname(found);
    }

    const info = makefileInfo(project, files, makeDir);
    const problems: Problem[] = [];
    for (const target of targets) {
      if (definesTarget(info, target.value)) continue;
      const path = resolve(makeDir, target.value);
      if (project.exists(path) || (allowBuiltins && hasImplicitSource(project, path, info.suffixes))) continue;
      if (info.dynamic) continue;
      problems.push(
        notDefined("Make target", target.value, target, `\`${display(project, files[0] as string)}\``, info.targets),
      );
    }
    return problems;
  },
};
