import { dirname, join, resolve } from "node:path";

import type { Project } from "#src/project.ts";
import type { Token } from "#src/shell.ts";
import { closest } from "#src/text.ts";

import type { Problem, TaskRunner } from "./types.ts";
import { display, flagValue, flagValues, notDefined, parseArgs } from "./util.ts";

// ---------------------------------------------------------------- Maven

export const MAVEN_PHASES = [
  // clean lifecycle
  "pre-clean",
  "clean",
  "post-clean",
  // default lifecycle
  "validate",
  "initialize",
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "compile",
  "process-classes",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
  "test-compile",
  "process-test-classes",
  "test",
  "prepare-package",
  "package",
  "pre-integration-test",
  "integration-test",
  "post-integration-test",
  "verify",
  "install",
  "deploy",
  // site lifecycle
  "pre-site",
  "site",
  "post-site",
  "site-deploy",
];

interface MavenModule {
  dir: string;
  artifactId: string | undefined;
}

interface MavenReactor {
  pom: string;
  modules: MavenModule[];
  profiles: Set<string>;
}

function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function artifactIdOf(xml: string): string | undefined {
  const withoutParent = xml.replace(/<parent>[\s\S]*?<\/parent>/, "");
  return /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(withoutParent)?.[1];
}

/** Reads a Maven reactor: the root pom, its (recursive) modules and all declared profiles. */
export function mavenReactor(project: Project, pom: string): MavenReactor {
  return project.memo(`maven:${pom}`, () => {
    const reactor: MavenReactor = { pom, modules: [], profiles: new Set() };
    const visit = (file: string, depth: number) => {
      const xml = stripXmlComments(project.readText(file) ?? "");
      reactor.modules.push({ dir: dirname(file), artifactId: artifactIdOf(xml) });
      for (const m of xml.matchAll(/<profile>[\s\S]*?<id>\s*([^<\s]+)\s*<\/id>/g)) reactor.profiles.add(m[1] as string);
      if (depth > 8) return;
      for (const m of xml.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
        let child = resolve(dirname(file), m[1] as string);
        if (project.isDirectory(child)) child = join(child, "pom.xml");
        if (project.isFile(child) && !reactor.modules.some((mod) => join(mod.dir, "pom.xml") === child)) {
          visit(child, depth + 1);
        }
      }
    };
    visit(pom, 0);
    return reactor;
  });
}

const MAVEN_VALUED = [
  "-f",
  "--file",
  "-pl",
  "--projects",
  "-P",
  "--activate-profiles",
  "-s",
  "--settings",
  "-gs",
  "--global-settings",
  "-t",
  "--toolchains",
  "-gt",
  "--global-toolchains",
  "-T",
  "--threads",
  "-rf",
  "--resume-from",
  "-l",
  "--log-file",
  "-b",
  "--builder",
  "-D",
  "--define",
  "-emp",
  "--encrypt-master-password",
  "-ep",
  "--encrypt-password",
];

/** `mvn` / `./mvnw`: lifecycle phases, `-pl` modules and `-P` profiles. */
export const mavenRunner: TaskRunner = {
  id: "maven",
  executables: ["mvn", "mvnw", "mvnd"],
  check(args, ctx) {
    const { project } = ctx;
    const parsed = parseArgs(args.slice(1), {
      valued: MAVEN_VALUED,
      boolean: [
        "-fae",
        "-ff",
        "-fn",
        "-llr",
        "-am",
        "-amd",
        "-nsu",
        "-npr",
        "-ntp",
        "-cpu",
        "-up",
        "-npu",
        "-emp",
        "-ep",
      ],
    });
    // `-Dprop=value` and `-Pprofile` are written attached; parseArgs splits two-letter flags only.
    const problems: Problem[] = [];

    for (const goal of parsed.positionals) {
      if (goal.value.includes(":") || goal.value.includes("$")) continue; // plugin:goal
      if (MAVEN_PHASES.includes(goal.value)) continue;
      const suggestion = closest(goal.value, MAVEN_PHASES);
      problems.push({
        token: goal,
        name: goal.value,
        message: `\`${goal.value}\` is not a Maven lifecycle phase`,
        help: suggestion ? `Did you mean \`${suggestion}\`?` : "Plugin goals must be written as `plugin:goal`.",
      });
    }

    const fileFlag = flagValue(parsed, "-f", "--file");
    let pom: string | null;
    if (fileFlag) {
      const abs = project.resolveExisting(ctx.cwd, fileFlag.value);
      pom = project.isDirectory(abs) ? join(abs, "pom.xml") : abs;
      if (!project.isFile(pom)) {
        return [...problems, { token: fileFlag, message: `\`${fileFlag.value}\` does not exist` }];
      }
    } else {
      pom = project.findUp(ctx.cwd, ["pom.xml"]);
    }
    if (!pom) {
      if (project.findFilesNamed(["pom.xml"]).length) return problems; // probably run from a module directory
      return [...problems, { token: args[0] as Token, message: "No pom.xml found" }];
    }
    const reactor = mavenReactor(project, pom);
    const root = dirname(pom);
    const where = `\`${display(project, pom)}\``;

    for (const item of flagValues(parsed, "-pl", "--projects", "-rf", "--resume-from")) {
      const value = item.value.replace(/^[!-]/, "");
      if (value.startsWith("?") || !value) continue;
      const artifactId = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : null;
      const found = artifactId
        ? reactor.modules.some((m) => m.artifactId === artifactId)
        : reactor.modules.some((m) => m.dir === resolve(root, value)) ||
          reactor.modules.some((m) => m.artifactId === value);
      if (!found) {
        const names = reactor.modules.map((m) => (artifactId ? m.artifactId : display(project, m.dir)) ?? "");
        problems.push(notDefined("Maven module", artifactId ?? value, item, `the reactor of ${where}`, names));
      }
    }

    for (const item of flagValues(parsed, "-P", "--activate-profiles")) {
      const value = item.value.replace(/^[!+-]/, "");
      if (value.startsWith("?") || !value || reactor.profiles.has(value)) continue;
      const problem = notDefined("Maven profile", value, item, `${where} or its modules`, reactor.profiles);
      problems.push({
        ...problem,
        help:
          problem.help ?? "Profiles defined in settings.xml can't be checked; add them to the rule's `ignore` option.",
      });
    }
    return problems;
  },
};

// ---------------------------------------------------------------- Gradle

export const GRADLE_SETTINGS = ["settings.gradle.kts", "settings.gradle"];

interface GradleSettings {
  file: string;
  projects: Set<string>;
  /** Composite builds or computed includes: unknown project paths can't be ruled out. */
  dynamic: boolean;
}

/** Project paths included by a Gradle settings file (`include(":app", "lib:core")`). */
export function gradleSettings(project: Project, file: string): GradleSettings {
  return project.memo(`gradle:${file}`, () => {
    const text = (project.readText(file) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const projects = new Set<string>([":"]);
    let dynamic = /\bincludeBuild\b/.test(text);
    for (const m of text.matchAll(/\binclude(?:Flat)?\b\s*\(?([^)\n]*)\)?/g)) {
      const literals = [...(m[1] as string).matchAll(/["']([^"']+)["']/g)].map((l) => l[1] as string);
      if (!literals.length || /\$/.test(m[1] as string)) dynamic = true;
      for (const literal of literals) {
        const segments = literal.replace(/^:/, "").split(":");
        for (let i = 1; i <= segments.length; i++) projects.add(`:${segments.slice(0, i).join(":")}`);
      }
    }
    return { file, projects, dynamic };
  });
}

/** `gradle` / `./gradlew`: project paths in task selectors (`:app:test`) must be included in settings. */
export const gradleRunner: TaskRunner = {
  id: "gradle",
  executables: ["gradle", "gradlew"],
  check(args, ctx) {
    const { project } = ctx;
    const parsed = parseArgs(args.slice(1), {
      valued: [
        "-p",
        "--project-dir",
        "-b",
        "--build-file",
        "-c",
        "--settings-file",
        "-x",
        "--exclude-task",
        "-I",
        "--init-script",
        "--console",
        "--warning-mode",
        "--max-workers",
        "-D",
        "-P",
        "--include-build",
        "-g",
        "--gradle-user-home",
        "--priority",
        "--project-cache-dir",
        "-M",
        "--write-verification-metadata",
      ],
    });
    const dirFlag = flagValue(parsed, "-p", "--project-dir");
    const dir = dirFlag ? project.resolveExisting(ctx.cwd, dirFlag.value, "dir") : ctx.cwd;
    const settingsFlag = flagValue(parsed, "-c", "--settings-file");
    const file = settingsFlag
      ? project.resolveExisting(dir, settingsFlag.value, "file")
      : project.findUp(dir, GRADLE_SETTINGS);
    if (!file || !project.isFile(file)) return [];
    const settings = gradleSettings(project, file);
    if (settings.dynamic) return [];

    const atSettingsRoot = dir === dirname(file);
    const tasks = [
      ...parsed.positionals,
      ...parsed.flags.filter((f) => f.name === "-x" || f.name === "--exclude-task").flatMap((f) => f.values),
    ];
    const problems: Problem[] = [];
    for (const task of tasks) {
      if (!task.value.includes(":")) continue;
      // Relative selectors (`app:test`) are relative to the current project; only check them from the root.
      if (!task.value.startsWith(":") && !atSettingsRoot) continue;
      const segments = task.value.replace(/^:/, "").split(":");
      segments.pop(); // the task name itself
      if (!segments.length) continue;
      const path = `:${segments.join(":")}`;
      if (settings.projects.has(path)) continue;
      problems.push(
        notDefined(
          "Gradle project",
          path,
          task,
          `\`${display(project, file)}\``,
          [...settings.projects].filter((p) => p !== ":"),
        ),
      );
    }
    return problems;
  },
};
