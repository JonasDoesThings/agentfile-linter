import { basename, dirname, join } from "node:path";

import { extractFrontmatter, isFrontmatterDelimiter, parseFrontmatter } from "#src/frontmatter.ts";
import { ALWAYS_SKIPPED_DIRS, isWithin, type Project, tryRealpath } from "#src/project.ts";
import { closest, lineRange, splitLines } from "#src/text.ts";
import type { Position, ReportDescriptor, Rule, TreeDiscoveryContext, TreeInput } from "#src/types.ts";
import { isRecord } from "#src/util.ts";

export interface NoInvalidSkillOptions {
  /** Glob patterns of skills directories, relative to the project root. */
  directories: string[];
  /** Also enforce the Agent Skills specification (required `name`/`description`, name format, lengths). */
  spec: boolean;
}

const SKILL_FILE = "SKILL.md";
/** How deep skills may be nested in grouping folders (`skills/group/foo/SKILL.md`), as in Codex and OpenCode. */
const MAX_DEPTH = 6;
/**
 * How deep skills roots are looked for below a symlinked directory, which discovery doesn't walk
 * (`.claude -> ../shared/.claude` has its skills root one level down).
 */
const LINKED_DEPTH = 3;
/** Plugins keep their skills in `<plugin>/skills/`. */
const PLUGIN_SKILLS_DIR = "skills";
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
const SPEC_URL = "https://agentskills.io/specification";

export const DEFAULT_SKILL_DIRECTORIES = [
  "**/.claude/skills",
  "**/.agents/skills",
  "**/.github/skills",
  "**/.codex/skills",
  "**/.gemini/skills",
  "**/.cursor/skills",
  "**/.devin/skills",
  "**/.windsurf/skills",
  "**/.kiro/skills",
];

type FieldCheck = (value: unknown) => string | null;

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** Agents coerce numbers and booleans to strings (`name: 3000`); lists, mappings and null are wrong. */
const text: FieldCheck = (v) => (isScalar(v) ? null : "must be a string");
const anything: FieldCheck = () => null;
const flag: FieldCheck = (v) =>
  typeof v === "boolean" ||
  v === 0 ||
  v === 1 ||
  (typeof v === "string" && /^(?:true|false|yes|no|on|off|1|0)$/i.test(v))
    ? null
    : "must be `true` or `false`";
const textOrList: FieldCheck = (v) =>
  isScalar(v) || (Array.isArray(v) && v.every(isScalar)) ? null : "must be a string or a list of strings";
const mapping: FieldCheck = (v) => (isRecord(v) ? null : "must be a mapping of `key: value` pairs");
const oneOf =
  (...values: string[]): FieldCheck =>
  (v) =>
    typeof v === "string" && values.includes(v) ? null : `must be one of ${values.map((x) => `\`${x}\``).join(", ")}`;

/**
 * Frontmatter fields of the Agent Skills specification, Claude Code and Cursor,
 * with the values they accept. Unknown fields are ignored by agents and only
 * reported when they look like a misspelling of one of these.
 */
const FIELDS: Record<string, FieldCheck> = {
  // Agent Skills specification
  name: text,
  description: text,
  license: text,
  compatibility: text,
  metadata: mapping,
  "allowed-tools": textOrList,
  // Claude Code
  when_to_use: text,
  "argument-hint": anything, // `[issue-number]` is a YAML list; Claude Code turns it into a string
  arguments: textOrList,
  "disable-model-invocation": flag,
  "user-invocable": flag,
  "disallowed-tools": textOrList,
  model: text,
  effort: oneOf("low", "medium", "high", "xhigh", "max"),
  context: oneOf("fork"),
  agent: text,
  background: flag,
  hooks: mapping,
  paths: textOrList,
  shell: oneOf("bash", "powershell"),
  // Cursor
  icon: text,
  color: text,
  globs: textOrList,
};

const squash = (key: string) => key.toLowerCase().replace(/[-_\s]/g, "");

/** Known fields by their squashed spelling (`allowedtools` → `allowed-tools`). */
const SQUASHED_FIELDS = new Map(Object.keys(FIELDS).map((field) => [squash(field), field]));

/** Shorter fields are one edit away from ordinary words (`content` → `context`, `colors` → `color`). */
const FUZZY_MIN_LENGTH = 8;

/** The known field an unknown key most likely misspells (`descripton`, `allowed_tools`), if any. */
function misspelledField(key: string): string | undefined {
  const squashed = squash(key);
  const sameWords = SQUASHED_FIELDS.get(squashed);
  if (sameWords) return sameWords;
  if (squashed.length < FUZZY_MIN_LENGTH) return undefined;
  const candidates = [...SQUASHED_FIELDS.keys()].filter(
    // A plural or singular of a field (`argument`, `backgrounds`) is more likely a custom key.
    (field) => field.length >= FUZZY_MIN_LENGTH && field !== `${squashed}s` && `${field}s` !== squashed,
  );
  const match = closest(squashed, candidates, squashed.length >= 10 ? 2 : 1);
  return match === undefined ? undefined : SQUASHED_FIELDS.get(match);
}

/** Problems with a skill name under the Agent Skills specification. */
function nameProblem(name: string): string | null {
  if (Array.from(name).length > NAME_MAX) return `must be at most ${NAME_MAX} characters long`;
  if (name !== name.toLowerCase() || !/^[\p{L}\p{N}-]+$/u.test(name)) {
    return "must contain only lowercase letters, digits and hyphens";
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "must not start or end with a hyphen or contain `--`";
  }
  return null;
}

/** Finds a frontmatter block that doesn't start on the first line (after blank lines). */
function lateFrontmatterLine(lines: readonly string[]): number | null {
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first <= 0 || !isFrontmatterDelimiter(lines[first] ?? "")) return null;
  const next = lines.slice(first + 1).find((line) => line.trim() !== "") ?? "";
  return /^[\w-]+:(?:\s|$)/.test(next) ? first + 1 : null;
}

function looksLikeSkill(content: string): boolean {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return false;
  const parsed = parseFrontmatter(frontmatter);
  return parsed.ok && parsed.keyLines.has("name") && parsed.keyLines.has("description");
}

/**
 * The directory names a skills root can have, or null when a pattern ends in a wildcard.
 * Plugin skills roots are always named `skills`.
 */
function rootNames(patterns: readonly string[]): Set<string> | null {
  const names = new Set([PLUGIN_SKILLS_DIR]);
  for (const pattern of patterns) {
    const name = pattern.slice(pattern.lastIndexOf("/") + 1);
    if (!name || /[*?[\]{}!\\]/.test(name)) return null;
    names.add(name);
  }
  return names;
}

interface SkillRoot {
  project: Project;
  path: string;
}

type LayoutProblem = Pick<ReportDescriptor, "message" | "help">;
type SkillInput = TreeInput & ({ problem: LayoutProblem } | { options: NoInvalidSkillOptions; project: Project });
type SkillReporter = (descriptor: Omit<ReportDescriptor, "start"> & { start?: Position }) => void;

class SkillDiscovery {
  private readonly globs = new Map<string, Bun.Glob>();
  private readonly explicitFiles: Set<string>;
  private readonly explicitFileAncestors = new Set<string>();
  private readonly inputs = new Map<string, SkillInput>();

  constructor(private readonly ctx: TreeDiscoveryContext<NoInvalidSkillOptions>) {
    this.explicitFiles = new Set(ctx.explicitFiles);
    for (const path of ctx.explicitFiles) {
      for (let dir = dirname(path); ; dir = dirname(dir)) {
        this.explicitFileAncestors.add(dir);
        if (dirname(dir) === dir) break;
      }
    }
  }

  find(): SkillInput[] {
    const patterns = [
      ...new Set(
        this.ctx.discoveryOptions.flatMap(({ directories }) =>
          (directories ?? []).map((pattern) => pattern.replace(/^\.?\//, "").replace(/\/$/, "")),
        ),
      ),
    ];
    const directories = new Set(this.ctx.directories);
    for (const dir of this.ctx.directories) {
      if (this.ctx.projectFor(dirname(dir)).isSymlink(dir)) this.addLinkedDirectories(dir, directories);
    }
    // A path inside a skills directory (`contextlint .claude/skills/foo`) is checked when that
    // skills directory is in the project. Directories outside the project never count.
    for (const dir of [...this.ctx.directoryInputs, ...this.ctx.explicitFiles.map(dirname)]) {
      const { root } = this.ctx.projectFor(dir);
      for (let ancestor = dir; isWithin(root, ancestor); ancestor = dirname(ancestor)) {
        directories.add(ancestor);
        if (ancestor === root) break;
      }
    }
    // Most directories can't be a skills root: skip them before matching globs.
    const names = rootNames(patterns);
    for (const dir of [...directories].toSorted()) {
      if (names && !names.has(basename(dir))) continue;
      const root = { project: this.ctx.projectFor(dirname(dir)), path: dir };
      if (this.isSkillsRoot(root, patterns)) this.findInRoot(root);
    }
    return [...this.inputs.values()];
  }

  /**
   * Adds the directories up to {@link LINKED_DEPTH} levels below a symlinked directory. Links that
   * resolve outside the project (`home -> ~`) are not followed, so results don't depend on the machine.
   */
  private addLinkedDirectories(dir: string, out: Set<string>, ancestors: readonly string[] = []): void {
    const real = tryRealpath(dir);
    if (!real || ancestors.includes(real) || ancestors.length >= LINKED_DEPTH) return;
    const project = this.ctx.projectFor(dir);
    if (!isWithin(tryRealpath(project.root) ?? project.root, real)) return;
    for (const name of project.readDir(dir) ?? []) {
      const path = join(dir, name);
      if (ALWAYS_SKIPPED_DIRS.has(name) || !project.isDirectory(path) || this.ctx.isIgnored(path, true)) continue;
      out.add(path);
      this.addLinkedDirectories(path, out, [...ancestors, real]);
    }
  }

  private isSelected(path: string): boolean {
    return this.explicitFiles.has(path) || this.ctx.directoryInputs.some((dir) => isWithin(dir, path));
  }

  private canVisit(dir: string): boolean {
    return (
      this.isSelected(dir) ||
      this.explicitFileAncestors.has(dir) ||
      this.ctx.directoryInputs.some((input) => isWithin(dir, input))
    );
  }

  private isSkillsRoot({ project, path: dir }: SkillRoot, patterns: readonly string[]): boolean {
    // Claude Code plugins keep their skills in `<plugin>/skills/`. Only a manifest inside the
    // project counts.
    if (basename(dir) === PLUGIN_SKILLS_DIR) {
      const owner = this.ctx.projectFor(dir);
      const manifest = join(dirname(dir), ".claude-plugin", "plugin.json");
      if (owner.contains(manifest) && owner.isFile(manifest)) return true;
    }
    // Patterns match the path relative to the project root, never where the project is on disk.
    const rel = project.relative(dir);
    if (!rel || !project.contains(dir)) return false;
    return patterns.some((pattern) => {
      let glob = this.globs.get(pattern);
      if (!glob) {
        glob = new Bun.Glob(pattern.replace(/^\.?\//, "").replace(/\/$/, ""));
        this.globs.set(pattern, glob);
      }
      return glob.match(rel);
    });
  }

  /** Options for a selected file in a skills root, as the overrides matching the file or the root set them. */
  private selectedOptions(root: SkillRoot, path: string): NoInvalidSkillOptions | null {
    if (!this.isSelected(path)) return null;
    const options = this.ctx.optionsFor(path, root.path);
    return this.isSkillsRoot(root, options.directories) ? options : null;
  }

  /** Visible, non-ignored entries of a directory, sorted. */
  private entries(project: Project, dir: string): { name: string; path: string; isDir: boolean }[] {
    return (project.readDir(dir) ?? [])
      .filter((name) => !name.startsWith("."))
      .toSorted()
      .map((name) => {
        const path = join(dir, name);
        return { name, path, isDir: project.isDirectory(path) };
      })
      .filter(
        ({ path, isDir }) =>
          this.explicitFiles.has(path) ||
          (isDir && this.explicitFileAncestors.has(path)) ||
          !this.ctx.isIgnored(path, isDir),
      );
  }

  private addProblem(root: SkillRoot, path: string, problem: LayoutProblem): void {
    this.inputs.set(path, { path, root: root.path, problem });
  }

  private findInRoot(root: SkillRoot): void {
    const { project, path } = root;
    const real = tryRealpath(path);
    if (!real) return;
    for (const entry of this.entries(project, path)) {
      if (entry.isDir) {
        if (this.canVisit(entry.path)) this.findInDirectory(root, entry.path, [real]);
        continue;
      }
      if (!this.selectedOptions(root, entry.path)) continue;
      if (!project.exists(entry.path)) {
        if (project.isSymlink(entry.path)) {
          this.addProblem(root, entry.path, {
            message: `\`${entry.name}\` is a broken symbolic link`,
            help: "Point the link at an existing skill directory or remove it.",
          });
        }
      } else if (entry.name.toUpperCase() === SKILL_FILE.toUpperCase()) {
        this.addProblem(root, entry.path, {
          message: `\`${entry.name}\` must be inside a skill directory, not directly in \`${basename(path)}/\``,
          help: `Move it to \`${basename(path)}/<skill-name>/${SKILL_FILE}\`.`,
        });
      } else if (
        /\.md$/i.test(entry.name) &&
        project.isFile(entry.path) &&
        looksLikeSkill(project.readText(entry.path) ?? "")
      ) {
        const stem = entry.name.replace(/\.md$/i, "");
        this.addProblem(root, entry.path, {
          message: `\`${entry.name}\` is not loaded as a skill: each skill needs its own directory`,
          help: `Move it to \`${stem}/${SKILL_FILE}\`.`,
        });
      }
    }
  }

  /**
   * Checks a directory below a skills root: either a skill (it has a SKILL.md)
   * or a grouping folder for nested skills. Returns whether it contains skills.
   */
  private findInDirectory(root: SkillRoot, dir: string, ancestors: readonly string[]): boolean {
    const real = tryRealpath(dir);
    if (!real || ancestors.includes(real)) return false;
    const { project } = root;
    const entries = this.entries(project, dir);
    const skill = entries.find((e) => e.name === SKILL_FILE);
    if (skill) {
      const options = this.selectedOptions(root, skill.path);
      if (options) {
        if (project.isFile(skill.path)) {
          this.inputs.set(skill.path, { path: skill.path, root: root.path, options, project });
        } else if (project.isSymlink(skill.path) && !project.exists(skill.path)) {
          this.addProblem(root, skill.path, {
            message: `\`${SKILL_FILE}\` is a broken symbolic link`,
            help: "Point the link at an existing skill file or replace it with a regular file.",
          });
        } else {
          this.addProblem(root, skill.path, {
            message: `\`${SKILL_FILE}\` must be a regular file`,
            help: `Put the skill instructions in a Markdown file named \`${SKILL_FILE}\`.`,
          });
        }
      }
      return true;
    }
    const files = entries.filter((e) => !e.isDir && project.isFile(e.path));
    const selectedFiles = files.filter((e) => this.selectedOptions(root, e.path));
    const misnamed = selectedFiles.find((e) => /^skills?\.(?:md|markdown)$/i.test(e.name));
    if (misnamed) {
      this.addProblem(root, misnamed.path, {
        message: `\`${misnamed.name}\` must be named exactly \`${SKILL_FILE}\``,
        help: `Agents look for \`${SKILL_FILE}\`; other spellings are not found on case-sensitive file systems.`,
      });
    }
    // Skills nested below a misnamed SKILL.md are still checked: agents on case-sensitive file
    // systems don't see the misnamed file, so they look for skills in the subdirectories.
    let nested = false;
    if (ancestors.length < MAX_DEPTH) {
      const parents = [...ancestors, real];
      for (const sub of entries) {
        if (sub.isDir && this.canVisit(sub.path) && this.findInDirectory(root, sub.path, parents)) nested = true;
      }
    }
    if (misnamed) return true;
    if (!nested && ancestors.length === 1) {
      // A Markdown file with frontmatter is most likely a misnamed SKILL.md.
      const candidate = selectedFiles.find(
        (e) => /\.md$/i.test(e.name) && looksLikeSkill(project.readText(e.path) ?? ""),
      );
      if (candidate) {
        this.addProblem(root, candidate.path, {
          message: `\`${basename(dir)}/\` has no \`${SKILL_FILE}\`, so it is not loaded as a skill`,
          help: `Rename \`${candidate.name}\` to \`${SKILL_FILE}\`.`,
        });
      }
    }
    return nested;
  }
}

function checkSkillFile(
  { path, project, options }: Extract<SkillInput, { project: Project }>,
  report: SkillReporter,
): void {
  const content = project.readText(path);
  if (content === null) {
    report({ message: `Cannot read \`${SKILL_FILE}\`` });
    return;
  }
  const lines = splitLines(content);
  const at = (line: number) => lineRange(lines, line);
  const dirName = basename(dirname(path));

  const frontmatter = extractFrontmatter(lines);
  if (!frontmatter) {
    const late = lateFrontmatterLine(lines);
    if (late !== null) {
      report({
        message: "Frontmatter must start on the first line, or agents treat it as plain text",
        help: "Remove the blank lines before the opening `---`.",
        ...at(late),
      });
    } else if (options.spec) {
      report({
        message: `\`${SKILL_FILE}\` has no frontmatter with \`name\` and \`description\``,
        help: `Start the file with a frontmatter block: a \`---\` line, \`name: ${dirName}\`, \`description: <what the skill does and when to use it>\` and a closing \`---\` line.`,
        ...at(1),
      });
    }
    return;
  }
  if (!frontmatter.closed) {
    report({
      message: "Frontmatter is not closed",
      help: "End the frontmatter with a `---` line before the Markdown content.",
      ...at(1),
    });
    return;
  }
  const parsed = parseFrontmatter(frontmatter);
  if (!parsed.ok) {
    const failing = lines[parsed.line - 1] ?? "";
    const tolerated =
      parsed.mistake === "colon" && failing.startsWith("description:")
        ? " Claude Code tolerates this in `description`, but other agents' YAML parsers reject the whole frontmatter."
        : "";
    report({
      message: "Frontmatter is not valid YAML",
      help: parsed.help + tolerated,
      ...at(parsed.line),
    });
    return;
  }
  const data = parsed.data ?? {};
  if (!isRecord(data)) {
    report({
      message: "Frontmatter must be a mapping of `key: value` pairs",
      ...at(frontmatter.firstLine),
    });
    return;
  }
  for (const { key, line } of parsed.duplicates) {
    report({
      message: key === undefined ? "Duplicate frontmatter key" : `Duplicate frontmatter field \`${key}\``,
      help: "YAML forbids duplicate keys; many parsers silently keep only the last value.",
      ...at(line),
    });
  }
  checkFields(parsed.keyLines, data, options, dirName, at, report);
}

function checkFields(
  keyLines: ReadonlyMap<string, number>,
  data: Record<string, unknown>,
  options: NoInvalidSkillOptions,
  dirName: string,
  at: (line: number) => { start: Position; end: Position },
  report: SkillReporter,
): void {
  const lineOf = (key: string) => keyLines.get(key) ?? 1;

  for (const [key, value] of Object.entries(data)) {
    const check = Object.hasOwn(FIELDS, key) ? FIELDS[key] : undefined;
    if (!check) {
      const suggestion = misspelledField(key);
      if (suggestion) {
        report({
          message: `Unknown frontmatter field \`${key}\`; did you mean \`${suggestion}\`?`,
          help: "Agents ignore unknown fields, so this setting has no effect.",
          ...at(lineOf(key)),
        });
      }
      continue;
    }
    const problem = value === null ? "has no value" : check(value);
    if (problem) report({ message: `\`${key}\` ${problem}`, ...at(lineOf(key)) });
  }

  const str = (key: string) => (isScalar(data[key]) ? String(data[key]).trim() : undefined);
  const description = str("description");
  if (description === "") {
    report({ message: "`description` must not be empty", ...at(lineOf("description")) });
  }
  const compatibility = str("compatibility");
  const compatibilityLength = Array.from(compatibility ?? "").length;
  if (compatibilityLength > COMPATIBILITY_MAX) {
    report({
      message: `\`compatibility\` must be at most ${COMPATIBILITY_MAX} characters long (it has ${compatibilityLength})`,
      ...at(lineOf("compatibility")),
    });
  }
  if (!options.spec) return;

  const specHelp = `Required by the Agent Skills specification (${SPEC_URL}).`;
  const name = str("name");
  if (!("name" in data)) {
    report({
      message: "Frontmatter is missing `name`",
      help: `Add \`name: ${dirName}\`. ${specHelp}`,
      ...at(1),
    });
  } else if (name !== undefined) {
    const normalized = name.normalize("NFKC");
    const problem = normalized === "" ? "must not be empty" : nameProblem(normalized);
    if (problem) {
      report({ message: `Skill name \`${name}\` ${problem}`, help: specHelp, ...at(lineOf("name")) });
    } else if (normalized !== dirName.normalize("NFKC")) {
      report({
        message: `Skill name \`${name}\` does not match its directory \`${dirName}\``,
        help: "Rename the directory or change `name`. Several agents (e.g. Cursor, VS Code) skip skills whose name differs.",
        ...at(lineOf("name")),
      });
    }
  }
  const descriptionLength = Array.from(description ?? "").length;
  if (!("description" in data)) {
    report({
      message: "Frontmatter is missing `description`",
      help: `Describe what the skill does and when to use it; agents choose skills by their description. ${specHelp}`,
      ...at(1),
    });
  } else if (descriptionLength > DESCRIPTION_MAX) {
    report({
      message: `\`description\` must be at most ${DESCRIPTION_MAX} characters long (it has ${descriptionLength})`,
      help: specHelp,
      ...at(lineOf("description")),
    });
  }
}

export const noInvalidSkill: Rule<NoInvalidSkillOptions, SkillInput> = {
  meta: {
    name: "context/no-invalid-skill",
    description: "Skill directories must have a valid layout and SKILL.md files valid frontmatter",
    categories: ["recommended"],
    defaultSeverity: "error",
    schema: {
      type: "object",
      properties: {
        directories: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns of skills directories, relative to the project root. `skills/` directories of Claude Code plugins are always checked.",
        },
        spec: {
          type: "boolean",
          description:
            "Enforce the Agent Skills specification: required `name` and `description`, name format and length, name matching the directory.",
        },
      },
    },
  },
  defaultOptions: { directories: DEFAULT_SKILL_DIRECTORIES, spec: true },
  collectTreeInputs(ctx) {
    return new SkillDiscovery(ctx).find();
  },
  checkTree(ctx) {
    for (const input of ctx.treeInputs) {
      const { path } = input;
      const report: SkillReporter = (descriptor) => ctx.report(path, { start: { line: 1, column: 1 }, ...descriptor });
      if ("problem" in input) {
        report(input.problem);
      } else {
        ctx.markChecked(path);
        checkSkillFile(input, report);
      }
    }
  },
};
