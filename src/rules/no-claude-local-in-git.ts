import { basename, dirname, join, relative } from "node:path";

import { listPrivatelyIgnored, listTrackedAndUnignoredFiles } from "#src/git.ts";
import { ALWAYS_SKIPPED_DIRS, isWithin } from "#src/project.ts";
import type { Rule, TreeInput } from "#src/types.ts";

const LOCAL_FILE = "CLAUDE.local.md";

type State =
  /** Tracked, with a file in the working tree. */
  | "tracked"
  /** Tracked, but deleted from the working tree or left out of a sparse checkout. */
  | "tracked-missing"
  /** Untracked and not ignored at all. */
  | "unignored"
  /** Untracked and ignored only by `.git/info/exclude` or a global ignore file. */
  | "privately-ignored";

type LocalFile = TreeInput & { repository: string; state: State; skipWorktree: boolean };

/** Quotes a command argument for POSIX shells when it needs quoting. */
const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/** A `git rm --cached` command for `path` that works from `cwd`. */
function removeFromIndexCommand(cwd: string, { path, repository, skipWorktree }: LocalFile): string {
  // Skip-worktree entries are refused without --sparse.
  const rm = skipWorktree ? "rm --cached --sparse" : "rm --cached";
  if (isWithin(repository, cwd)) return `git ${rm} -- ${shellQuote(relative(cwd, path))}`;
  return `git -C ${shellQuote(relative(cwd, repository))} ${rm} -- ${shellQuote(relative(repository, path))}`;
}

export const noClaudeLocalInGit: Rule<[], LocalFile> = {
  meta: {
    docs: {
      description: "Personal CLAUDE.local.md files must be untracked and covered by .gitignore",
      recommended: true,
      category: "correctness",
    },
  },
  collectTreeInputs(ctx) {
    const explicit = new Set(ctx.explicitFiles.filter((path) => basename(path) === LOCAL_FILE));
    // Discovery lists symlinked directories without walking them. Their project root is found
    // through the link, which can lead into another repository outside the linted tree.
    const discovered = ctx.directories.filter(
      (dir) => ctx.directoryInputs.includes(dir) || !ctx.projectFor(dirname(dir)).isSymlink(dir),
    );
    const directories = [...discovered, ...[...explicit].map(dirname)];
    const projects = new Set(directories.map((dir) => ctx.projectFor(dir)));
    const files = new Map<string, LocalFile>();
    for (const project of projects) {
      if (!project.exists(join(project.root, ".git"))) continue;
      const targets = ctx.directoryInputs.some((dir) => isWithin(dir, project.root))
        ? [project.root]
        : ctx.directoryInputs.filter((dir) => project.contains(dir));
      const namedFiles = [...explicit].filter((path) => project.contains(path)).map((path) => project.relative(path));
      const excludeDirs = [...ALWAYS_SKIPPED_DIRS].filter(
        (dir) => !namedFiles.some((path) => path.split("/").includes(dir)),
      );
      const pathspecs = namedFiles.map((path) => `:(literal)${path}`);
      for (const dir of targets) {
        const rel = project.relative(dir).replace(/[\\*?[\]]/g, "\\$&");
        const prefix = rel ? `${rel}/` : "";
        pathspecs.push(`:(glob)${prefix}**/${LOCAL_FILE}`);
        for (const name of excludeDirs) pathspecs.push(`:(exclude,glob)${prefix}**/${name}/**`);
      }
      if (!pathspecs.length) continue;
      const found: LocalFile[] = [];
      for (const { path, tracked, skipWorktree } of listTrackedAndUnignoredFiles(project.root, pathspecs)) {
        if (basename(path) !== LOCAL_FILE) continue;
        const absolute = join(project.root, path);
        if (!explicit.has(absolute)) {
          if (!ctx.directoryInputs.some((dir) => isWithin(dir, absolute))) continue;
          if (ctx.isIgnored(absolute, false, { gitignore: false })) continue;
        }
        const inWorktree = project.exists(absolute) || project.isSymlink(absolute);
        const state = tracked ? (inWorktree ? "tracked" : "tracked-missing") : "unignored";
        found.push({ path: absolute, repository: project.root, state, skipWorktree });
      }
      const untracked = found.filter((file) => file.state === "unignored");
      const privatelyIgnored = listPrivatelyIgnored(
        project.root,
        untracked.map((file) => project.relative(file.path)),
      );
      for (const file of untracked) {
        if (privatelyIgnored.has(project.relative(file.path))) file.state = "privately-ignored";
      }
      for (const file of found) files.set(file.path, file);
    }
    return [...files.values()];
  },
  checkTree(ctx) {
    for (const file of ctx.treeInputs) {
      const name = `\`${relative(ctx.cwd, file.path)}\``;
      const rm = `\`${removeFromIndexCommand(ctx.cwd, file)}\``;
      const [message, help] = {
        tracked: [
          `${name} is tracked by Git`,
          `Add \`${LOCAL_FILE}\` to \`.gitignore\` and run ${rm} to stop tracking it while keeping your local copy.`,
        ],
        "tracked-missing": [
          `${name} is tracked by Git but not in the working tree`,
          `Run ${rm} to remove it from the index and add \`${LOCAL_FILE}\` to \`.gitignore\`.`,
        ],
        unignored: [`${name} should be ignored by Git`, `Add \`${LOCAL_FILE}\` to a shared \`.gitignore\`.`],
        "privately-ignored": [
          `${name} is only ignored by a private Git exclude`,
          `Add \`${LOCAL_FILE}\` to a shared \`.gitignore\`. \`.git/info/exclude\` and global ignore files are not shared, so a teammate or a config change can still commit it.`,
        ],
      }[file.state];
      ctx.report(file.path, { message, help });
    }
  },
};
