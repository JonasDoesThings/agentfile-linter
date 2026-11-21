import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Maximum number of git processes running at the same time. */
const MAX_PARALLEL = 8;

let running = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  else running++;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else running--;
  }
}

/**
 * Variables that point git at a specific repository or index. Git hooks set
 * them (sometimes to relative paths), which would break `git -C <dir>`.
 */
const REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

/** Read on every call, so a long-running process sees changes to its environment. */
function gitEnv(): Record<string, string | undefined> {
  // History walks in partial clones must not fetch missing objects, including on
  // older Git versions that do not recognize GIT_NO_LAZY_FETCH. The system attributes file
  // is ignored so that results don't depend on the machine (see `matchesAfterCrlfConversion`).
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_ATTR_NOSYSTEM: "1",
  };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return env;
}

/** Runs git in `cwd`. Returns stdout, or null when git fails or is not installed. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return withSlot(async () => {
    try {
      const { stdout } = await exec(
        "git",
        ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          env: gitEnv(),
          windowsHide: true,
        },
      );
      return stdout;
    } catch {
      return null;
    }
  });
}

export interface CommitTime {
  /** Unix seconds. */
  time: number;
  /** `YYYY-MM-DD` in the committer's time zone, as `git log` shows it. */
  date: string;
}

/**
 * Committer time of the last commit that changed a tracked path on the current branch, if available.
 * `--first-parent` makes a merge count as the change, so a file merged from an old branch is as
 * recent as the merge, not as the branch commit.
 */
export async function lastCommitTime(path: string): Promise<CommitTime | null> {
  const out = await git(dirname(path), [
    "log",
    "-1",
    "--first-parent",
    "--no-show-signature",
    "--format=%ct %cs",
    "--",
    basename(path),
  ]);
  const match = /^(\d+) (\d{4}-\d\d-\d\d)$/.exec(out?.trim() ?? "");
  return match ? { time: Number(match[1]), date: match[2] as string } : null;
}

interface IndexEntry {
  mode: string;
  oid: string;
}

type IndexState =
  | { kind: "tracked"; entry: IndexEntry }
  | { kind: "untracked" }
  | { kind: "unmerged" }
  | { kind: "unavailable" };

/** Reads the index without refreshing it against the working tree. */
export async function readIndex(path: string): Promise<IndexState> {
  const out = await git(dirname(path), ["ls-files", "--stage", "-z", "--", basename(path)]);
  if (out === null) return { kind: "unavailable" };
  if (out === "") return { kind: "untracked" };
  const match = /^(\d+) ([0-9a-f]+) 0\t[^\0]+\0$/.exec(out);
  if (!match?.[1] || !match[2]) return { kind: "unmerged" };
  return { kind: "tracked", entry: { mode: match[1], oid: match[2] } };
}

function blobOid(bytes: Buffer, indexOid: string): string {
  const algorithm = indexOid.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Caches values for one lint run, such as `Project.memo`. */
export interface GitCache {
  memo<T>(key: string, compute: () => T): T;
}

/**
 * `core.fileMode` from the repository's own config (`git init` sets it for the file system).
 * Global and system config are ignored so that results don't depend on the machine.
 */
function repositoryFileMode(cwd: string, cache: GitCache): Promise<boolean> {
  return cache.memo(`git-config:${cwd}`, () =>
    git(cwd, ["config", "--local", "--get-regexp", "^core\\.filemode$"]).then((out) => {
      // A key without `=` (`[core] filemode`) is printed without a value and means true.
      // `filemode =` is printed with a trailing space and means false.
      const line = (out ?? "").split("\n").findLast(Boolean);
      if (line === undefined) return true;
      const space = line.indexOf(" ");
      return space === -1 || !/^(?:false|no|off|0|)$/i.test(line.slice(space + 1));
    }),
  );
}

const attributeIsInactive = (value: string | undefined) => value === "unspecified" || value === "unset";

/**
 * Whether the file differs from the index only by CRLF line endings, as Git's built-in conversion
 * writes them, without running any filter. `core.autocrlf` is not consulted: Git for Windows sets
 * it in the system config, which is ignored so that results don't depend on the machine. A
 * difference only in line endings counts as unchanged unless the repository's attributes mark the
 * file as binary (`-text`, `-crlf`) or transform it (`filter`, `working-tree-encoding`).
 */
async function matchesAfterCrlfConversion(path: string, bytes: Buffer, indexOid: string): Promise<boolean> {
  // Latin-1 preserves every input byte when removing carriage returns.
  const raw = bytes.toString("latin1");
  const normalized = raw.replaceAll("\r\n", "\n");
  if (raw === normalized || normalized.includes("\r") || bytes.includes(0)) return false;
  if (blobOid(Buffer.from(normalized, "latin1"), indexOid) !== indexOid) return false;

  const cwd = dirname(path);
  const names = ["text", "crlf", "filter", "working-tree-encoding"];
  // Only the repository's own attributes count: an empty `core.attributesFile` also disables
  // the default global file (`~/.config/git/attributes`).
  const attributes = await git(cwd, ["-c", "core.attributesFile=", "check-attr", "-z", ...names, "--", basename(path)]);
  if (attributes === null) return false;
  const fields = attributes.split("\0");
  const [text, crlf, filter, encoding] = names.map((_, i) => fields[i * 3 + 2]);
  if (!attributeIsInactive(filter) || !attributeIsInactive(encoding) || text === "unset") return false;
  return text === "set" || text === "auto" || crlf !== "unset";
}

/**
 * Whether the index differs from HEAD or the working tree differs from the index.
 * Repository config is cached in `cache`, so it is read again on the next lint run.
 */
export async function hasUncommittedChanges(
  path: string,
  index: IndexState,
  mode: number,
  cache: GitCache,
): Promise<boolean> {
  if (index.kind === "unavailable") return false;
  if (index.kind === "unmerged") return true;
  const cwd = dirname(path);
  const name = basename(path);
  const head = await git(cwd, ["ls-tree", "-z", "HEAD", "--", name]);
  if (index.kind === "untracked") return Boolean(head);
  const { entry } = index;
  if (!head?.startsWith(`${entry.mode} blob ${entry.oid}\t`)) return true;
  // Compare the raw blob directly. Git status can run a repository's clean filters.
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return true;
  if (blobOid(bytes, entry.oid) !== entry.oid && !(await matchesAfterCrlfConversion(path, bytes, entry.oid))) {
    return true;
  }
  const fileMode = mode & 0o100 ? "100755" : "100644";
  if (fileMode === entry.mode) return false;
  return repositoryFileMode(cwd, cache);
}
