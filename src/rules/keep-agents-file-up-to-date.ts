import { basename } from "node:path";

import { hasUncommittedChanges, lastCommitTime, readIndex } from "#src/git.ts";
import type { Project } from "#src/project.ts";
import { countSchema } from "#src/schema.ts";
import { firstLineRange } from "#src/text.ts";
import type { Rule } from "#src/types.ts";

export interface KeepAgentsFileUpToDateOptions {
  /** Days without a change to the file after which it is reported. */
  warnIfNotUpdatedForDays: number | string;
  /** Only files with more characters than this (ignoring surrounding whitespace) are reported. */
  warnOnlyForFilesLongerThanChars: number | string;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Agent context files did not exist before 2023. Earlier modification times
 * come from tools that reset timestamps (1970 in the Nix store, 1980 in zip
 * archives, 1985 in npm packages), not from edits.
 */
const EARLIEST_MODIFICATION = Date.UTC(2023, 0, 1) / 1000;

interface LastUpdate {
  /** Unix seconds. */
  time: number;
  /** `YYYY-MM-DD`. */
  date: string;
  source: "commit" | "modification";
}

/** `YYYY-MM-DD` in UTC, so that the message doesn't depend on the machine's time zone. */
function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** The file's modification time, unless a tool reset it. */
function modification(path: string, project: Project): LastUpdate | null {
  const mtime = project.stat(path)?.mtimeMs;
  if (mtime === undefined || mtime / 1000 < EARLIEST_MODIFICATION) return null;
  const time = Math.floor(mtime / 1000);
  return { time, date: utcDate(time), source: "modification" };
}

export const keepAgentsFileUpToDate: Rule<KeepAgentsFileUpToDateOptions> = {
  meta: {
    name: "agentfile/keep-agents-file-up-to-date",
    description: "Context files must be revisited regularly (judged by their last Git commit or modification time)",
    categories: [],
    defaultSeverity: "warn",
    timeDependent: true,
    schema: {
      type: "object",
      properties: {
        warnIfNotUpdatedForDays: countSchema(
          "Report files not changed for more than this many days (by last commit, or by modification time for files without Git history).",
        ),
        warnOnlyForFilesLongerThanChars: countSchema(
          "Skip files with at most this many characters (ignoring surrounding whitespace), e.g. `@AGENTS.md` pointers.",
        ),
      },
    },
  },
  defaultOptions: { warnIfNotUpdatedForDays: 120, warnOnlyForFilesLongerThanChars: 0 },
  async check({ file, project, options, report }) {
    if (file.text.trim().length <= Number(options.warnOnlyForFilesLongerThanChars)) return;
    const maxDays = Number(options.warnIfNotUpdatedForDays);
    const daysSince = (update: LastUpdate) => Math.floor((Date.now() / 1000 - update.time) / DAY_SECONDS);
    // When a file was last changed: its last commit, or, for files without Git history, its
    // modification time. Checkouts of other version control systems write files with the
    // checkout time, so a modification time is never older than the last real change.
    // A symlinked file's content (and history) lives in its target.
    const commit = await lastCommitTime(file.realPath);
    let update: LastUpdate | null = commit ? { ...commit, source: "commit" } : modification(file.realPath, project);
    // Most files are recent, so the index is only read for old ones.
    if (update === null || daysSince(update) <= maxDays) return;
    const index = await readIndex(file.realPath);
    if (index.kind === "unmerged") return;
    // An untracked file can still have history from a deleted file at the same path.
    if (index.kind !== "tracked" && update.source === "commit") {
      update = modification(file.realPath, project);
      if (update === null || daysSince(update) <= maxDays) return;
    }
    const days = daysSince(update);
    const mode = project.stat(file.realPath)?.mode;
    if (mode === undefined || (await hasUncommittedChanges(file.realPath, index, mode, project))) return;

    const name = basename(file.path);
    const limit = `the ${maxDays}-day limit (\`warnIfNotUpdatedForDays\`)`;
    const byCommit = update.source === "commit";
    report({
      message: `\`${name}\` has not been updated in ${days} days (${byCommit ? "last commit" : "last modified"}: ${update.date})`,
      help: byCommit
        ? `Agent instructions go stale as the project changes. Review the file and commit any updates, even a small one, to reset ${limit}.`
        : `Agent instructions go stale as the project changes. Review the file and update it (or \`touch\` it if it is ` +
          `still accurate) to reset ${limit}. It has no Git history, so its modification time counts.`,
      ...firstLineRange(file.text),
    });
  },
};
