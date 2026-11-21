import { readlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readIndex } from "#src/git.ts";
import { toPosix } from "#src/gitignore.ts";
import { parseMarkdown, visit } from "#src/markdown.ts";
import { type Project, tryRealpath } from "#src/project.ts";
import { firstLineRange } from "#src/text.ts";
import type { ReportDescriptor, Rule } from "#src/types.ts";

import { normalizeContent, pointerImports } from "./no-agent-files-drift.ts";
import { findImports } from "./no-missing-path.ts";

const AGENTS = "AGENTS.md";
const CLAUDE = "CLAUDE.md";
const CLAUDE_LOCAL = "CLAUDE.local.md";

const WHY =
  `Since v2.1.277, Claude Code reads \`${AGENTS}\` when there is no \`${CLAUDE}\`, ` +
  `so a single \`${AGENTS}\` can serve all agents.`;

/** `tracked`: whether Git tracks `CLAUDE.md`, so that `git rm` and `git mv` work on it. */
function removalHelp(cwd: string, dir: string, tracked: boolean, rename = false): string {
  const agents = toPosix(relative(cwd, join(dir, AGENTS)));
  const claude = toPosix(relative(cwd, join(dir, CLAUDE)));
  const instruction = rename
    ? `Remove the symlink \`${agents}\` and rename \`${claude}\` to \`${agents}\``
    : `Delete \`${claude}\``;
  const directory = toPosix(relative(cwd, dir));
  // Keep paths with shell-specific quoting requirements out of executable suggestions.
  if (isAbsolute(directory) || /[^a-zA-Z0-9_./ -]/u.test(directory)) return `${WHY} ${instruction}.`;
  const quote = (path: string) => (directory ? `"./${path}"` : path);
  let command: string;
  if (tracked) {
    const git = directory ? `git -C "${directory}"` : "git";
    command = rename ? `rm ${quote(agents)} && ${git} mv ${CLAUDE} ${AGENTS}` : `${git} rm ${CLAUDE}`;
  } else {
    command = rename ? `rm ${quote(agents)} && mv ${quote(claude)} ${quote(agents)}` : `rm ${quote(claude)}`;
  }
  return `${WHY} ${instruction} (\`${command}\`).`;
}

/** A reason to remove `CLAUDE.md`. Help depends on whether Git tracks it (`git rm` fails otherwise). */
interface Problem {
  message: string;
  help: (tracked: boolean) => string;
}

/** Describes how `CLAUDE.md` merely mirrors `AGENTS.md`, or returns null when it has content of its own. */
function redundancy(project: Project, cwd: string, dir: string, text: string): Problem | null {
  const agentsPath = join(dir, AGENTS);
  const claudePath = join(dir, CLAUDE);
  const agentsReal = tryRealpath(agentsPath);
  const claudeReal = tryRealpath(claudePath);
  if (!agentsReal || !claudeReal) return null;

  if (agentsReal === claudeReal) {
    const claudeIsLink = project.isSymlink(claudePath);
    const agentsIsLink = project.isSymlink(agentsPath);
    if (claudeIsLink && !agentsIsLink) {
      return {
        message: `\`${CLAUDE}\` is a symlink to \`${AGENTS}\` and is not needed`,
        help: (tracked) => removalHelp(cwd, dir, tracked),
      };
    }
    if (agentsIsLink && !claudeIsLink) {
      return {
        message: `\`${AGENTS}\` is a symlink to \`${CLAUDE}\`; \`${CLAUDE}\` is not needed`,
        help: (tracked) => removalHelp(cwd, dir, tracked, true),
      };
    }
    const target = toPosix(relative(tryRealpath(dir) ?? dir, agentsReal));
    return {
      message: `\`${AGENTS}\` and \`${CLAUDE}\` both link to \`${target}\`; \`${CLAUDE}\` is not needed`,
      help: () => `${WHY} Make sure \`${AGENTS}\` links directly to \`${target}\` before deleting \`${CLAUDE}\`.`,
    };
  }

  const agentsText = project.readText(agentsPath);
  if (agentsText === null) return null;
  if (normalizeContent(text) === normalizeContent(agentsText)) {
    return {
      message: `\`${CLAUDE}\` is a copy of \`${AGENTS}\` and is not needed`,
      help: (tracked) => removalHelp(cwd, dir, tracked),
    };
  }
  const imports = pointerImports(text);
  if (imports?.length === 1 && imports[0] === AGENTS) {
    return {
      message: `\`${CLAUDE}\` only imports \`${AGENTS}\` and is not needed`,
      help: (tracked) => removalHelp(cwd, dir, tracked),
    };
  }
  return null;
}

/** Resolve the parent directory while retaining the identity of a file symlink. */
function fileEntry(path: string): string | null {
  const parent = tryRealpath(dirname(path));
  return parent === null ? null : join(parent, basename(path));
}

function linkTarget(path: string): string | null {
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

/** Other instruction files and symlinks may still rely on a proposed removal. */
function referencedCandidates(
  candidates: ReadonlyMap<string, unknown>,
  roots: ReadonlySet<string>,
  contextFiles: readonly string[],
  projectFor: (dir: string) => Project,
): Set<string> {
  const removals = new Map<string, string>();
  for (const dir of candidates.keys()) {
    const path = fileEntry(join(dir, CLAUDE));
    if (path) removals.set(path, dir);
  }
  const blocked = new Set<string>();
  const trace = (path: string, source: string, isImport: boolean): void => {
    const seen = new Set<string>();
    const sourceLink = isImport ? null : fileEntry(source);
    let previousLink = sourceLink;
    for (let entry = fileEntry(path); entry && !seen.has(entry);) {
      seen.add(entry);
      const dir = removals.get(entry);
      if (dir) {
        // The rule already gives instructions to replace or retarget its own AGENTS.md link.
        const agents = join(dirname(entry), AGENTS);
        const replacedLink = sourceLink === agents || previousLink === agents;
        if (!replacedLink) blocked.add(dir);
      }
      const target = linkTarget(entry);
      previousLink = entry;
      entry = target === null ? null : fileEntry(target);
    }
  };

  const visitedImports = new Set<string>();
  const checkImports = (project: Project, path: string): void => {
    if (visitedImports.has(path) || !project.contains(path) || !project.isFile(path)) return;
    visitedImports.add(path);
    const text = project.readText(path);
    // Most files have no import at all; only parse those that might (`@` also appears in emails and handles).
    if (!text?.includes("@") || findImports(text).length === 0) return;
    visit(parseMarkdown(text), "text", (node, ancestors) => {
      if (ancestors.some(({ type }) => type === "link" || type === "linkReference")) return;
      for (const { path: imp } of findImports(node.value)) {
        const target = resolve(dirname(path), imp);
        trace(target, path, true);
        checkImports(project, target);
      }
    });
  };

  // One pass over the cached project index, which skips git-ignored and always-skipped directories.
  for (const root of roots) {
    const project = projectFor(root);
    const { files, dirs, symlinks } = project.getIndex();
    for (const rel of symlinks) {
      const path = join(project.root, rel);
      const target = linkTarget(path);
      if (target) trace(target, path, false);
    }
    // Claude Code follows imports in every instruction file it loads (context files, `.claude/rules`,
    // commands, skills), so any Markdown file may depend on a removal.
    for (const rel of files) if (/\.md$/i.test(rel)) checkImports(project, join(project.root, rel));
    // `CLAUDE.local.md` is usually git-ignored, so it is missing from the index.
    for (const rel of ["", ...dirs]) checkImports(project, join(project.root, rel, CLAUDE_LOCAL));
  }
  for (const path of contextFiles) checkImports(projectFor(dirname(path)), path);
  return blocked;
}

function claudeFileRemains(project: Project, dir: string, candidates: ReadonlyMap<string, unknown>): boolean {
  return (
    project.isFile(join(dir, CLAUDE_LOCAL)) ||
    project.isFile(join(dir, ".claude", CLAUDE)) ||
    (!candidates.has(dir) && project.isFile(join(dir, CLAUDE)))
  );
}

/**
 * Find the highest removal candidate on this launch path, if nothing above it blocks the fallback.
 * The search stops at the project root: files above it (such as `~/Code/CLAUDE.md`) differ between
 * machines, and the result must not.
 */
function removalRoot(project: Project, dir: string, candidates: ReadonlyMap<string, unknown>): string | null {
  let root = dir;
  for (let current = dir; ; current = dirname(current)) {
    if (claudeFileRemains(project, current, candidates)) return null;
    if (candidates.has(current)) root = current;
    if (current === project.root || dirname(current) === current) return root;
  }
}

/** A retained file also blocks the fallback for sessions launched below a removal candidate. */
function subtreeIsClear(project: Project, dir: string, candidates: ReadonlyMap<string, unknown>): boolean {
  const rel = project.relative(dir);
  const prefix = rel ? `${rel}/` : "";
  const below = project
    .getIndex()
    .dirs.filter((sub) => sub.startsWith(prefix))
    .map((sub) => join(project.root, sub));
  return [dir, ...below].every((sub) => !claudeFileRemains(project, sub, candidates));
}

export const noUnnecessaryAgentFiles: Rule = {
  meta: {
    name: "agentfile/no-unnecessary-agent-files",
    description: "CLAUDE.md must not merely mirror AGENTS.md, which Claude Code reads itself",
    categories: [],
    defaultSeverity: "warn",
  },
  defaultOptions: {},
  async checkTree(ctx) {
    const candidates = new Map<string, Problem & Pick<ReportDescriptor, "start" | "end">>();
    const roots = new Set<string>();
    for (const path of ctx.contextFiles) {
      // Every context file is checked for being an unnecessary CLAUDE.md, even if it is not one.
      ctx.markChecked(path);
      const dir = dirname(path);
      // `.claude/CLAUDE.md` holds project (or, in `~/.claude`, user) instructions; Claude Code
      // never falls back to an `AGENTS.md` next to it.
      if (basename(path) !== CLAUDE || basename(dir) === ".claude" || !ctx.isEnabled(path)) continue;
      const project = ctx.projectFor(dir);
      if (!project.isFile(join(dir, AGENTS)) || !project.isFile(path)) continue;
      const text = project.readText(path);
      if (text === null) continue;
      const problem = redundancy(project, ctx.cwd, dir, text);
      const range = firstLineRange(text);
      if (!problem || ctx.isSuppressed(path, range.start)) continue;
      candidates.set(dir, { ...problem, ...range });
      roots.add(project.root);
    }
    if (candidates.size === 0) return;
    // Outside Git, or for an uncommitted file, `git rm` fails; plain `rm` works everywhere.
    const tracked = new Map<string, boolean>();
    await Promise.all(
      [...candidates.keys()].map(async (dir) => {
        const [claude, agents] = await Promise.all([readIndex(join(dir, CLAUDE)), readIndex(join(dir, AGENTS))]);
        // A committed `CLAUDE.md` next to an untracked or git-ignored `AGENTS.md` (often generated
        // locally) is the only copy other clones have.
        if (claude.kind === "tracked" && agents.kind === "untracked") candidates.delete(dir);
        else tracked.set(dir, claude.kind === "tracked");
      }),
    );
    if (candidates.size === 0) return;
    const referenced = referencedCandidates(candidates, roots, ctx.contextFiles, (dir) => ctx.projectFor(dir));
    for (const dir of referenced) candidates.delete(dir);

    const groups = new Map<string, { dir: string; descriptor: Problem & Pick<ReportDescriptor, "start" | "end"> }[]>();
    for (const [dir, descriptor] of candidates) {
      const root = removalRoot(ctx.projectFor(dir), dir, candidates);
      if (root === null) continue;
      const group = groups.get(root);
      if (group) group.push({ dir, descriptor });
      else groups.set(root, [{ dir, descriptor }]);
    }
    for (const [root, group] of groups) {
      if (!subtreeIsClear(ctx.projectFor(root), root, candidates)) continue;
      for (const { dir, descriptor } of group) {
        const scope = toPosix(relative(ctx.cwd, root)) || ".";
        const prefix = group.length > 1 ? `Apply the suggested removals under \`${scope}\` together. ` : "";
        const { help, ...rest } = descriptor;
        ctx.report(join(dir, CLAUDE), { ...rest, help: prefix + help(tracked.get(dir) ?? false) });
      }
    }
  },
};
