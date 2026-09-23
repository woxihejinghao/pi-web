import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { badRequest, forbidden } from "./errors.ts";
import { assertRelativePath } from "./workspace-files.ts";

const run = promisify(execFile);

/**
 * The changes panel's whole git surface: what changed, what is staged, what the
 * branch is, and the writes (stage, commit, push, discard, checkout).
 *
 * Every invocation goes through `git` with an argument array — never a shell
 * string — and `-C <project>`, so the only paths a caller chooses are the
 * project directory (already on the API's allowlist) and work-tree-relative
 * paths, which are checked here before git ever sees them.
 *
 * The change set is split into two diffs rather than one `git diff HEAD`:
 * *staged* is `git diff --cached` (index against HEAD) and *unstaged* is
 * `git diff` (work tree against index). A file can be in both (`MM`). One
 * combined diff could not tell the panel what a "stage this file" button would
 * actually move, and after a stage the unstaged copy must disappear — which is
 * exactly the boundary the two commands draw.
 */

/** Wall-clock ceiling per git invocation; pushes get their own, longer one. */
const TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;

/** Per-file patch cap. A longer patch is cut and the file marked truncated. */
export const MAX_PATCH_BYTES = 256 * 1024;

/** Changed files listed before the list is cut off (both sides together). */
export const MAX_FILES = 200;

/** Commits shown in the history list. */
export const LOG_LIMIT = 20;

/** What one `git diff` is allowed to buffer before we give up on its patch. */
const MAX_BUFFER = MAX_PATCH_BYTES * 4;

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** One changed file on one side (staged or unstaged) of the change set. */
export interface GitFileEntry {
  /** Path relative to the project root, as git reports it. */
  path: string;
  status: GitFileStatus;
  /** True when git produced no text patch because the file is binary. */
  binary: boolean;
  /** Unified diff for this side; `""` for an untracked or binary file. */
  patch: string;
  /** True when the patch was cut at `MAX_PATCH_BYTES`. */
  truncated: boolean;
}

export interface GitLogEntry {
  hash: string;
  short: string;
  /** First line of the commit message. */
  subject: string;
  author: string;
  /** Author date, ISO-8601. */
  date: string;
  /** Decorations: branch tips, remote tracking refs, tags. */
  refs: string[];
}

export interface GitStatusView {
  /** False when the directory is not a git work tree (a normal answer). */
  repository: boolean;
  /** Branch name, `HEAD@abc1234` when detached, null outside a repository. */
  branch: string | null;
  detached: boolean;
  /** Local branch names, most recently committed first. */
  branches: string[];
  /** Pushing target, e.g. `origin/main`; null when the branch has none. */
  upstream: string | null;
  /** Commits the upstream has that HEAD does not, and the reverse. */
  behind: number;
  ahead: number;
  /** Index against HEAD. */
  staged: GitFileEntry[];
  /** Work tree against index, untracked files included. */
  unstaged: GitFileEntry[];
  /** Changed files left out by `MAX_FILES`. */
  omittedFiles: number;
  log: GitLogEntry[];
  /** Set when git itself could not be run (missing binary, timeout, …). */
  error?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set for a killed child (buffer overflow or timeout) rather than an exit code. */
  killed: boolean;
}

async function git(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number; timeout?: number } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", ["-C", cwd, ...args], {
      timeout: options.timeout ?? TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        // This process only observes and moves things between the index and the
        // work tree; letting status write the index would race with a terminal
        // the user has open in the same repository.
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        LC_ALL: "C",
        // Without this a fetch/push that needs credentials waits on a prompt
        // nobody can see, until the timeout kills it. Failing immediately with
        // git's own message is the honest behavior for a web server.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { ok: true, stdout, stderr, killed: false };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; killed?: boolean; code?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? (err as Error).message,
      killed: failure.killed === true || failure.code === "ENOBUFS",
    };
  }
}

/** The first line of a git failure, which is the part that names the problem. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * What went wrong, in git's own words.
 *
 * git is inconsistent about the channel: a rejected push explains itself on
 * stderr, while `commit` writes its reason (`nothing to commit, working tree
 * clean`) to stdout above an otherwise uninteresting `On branch main`. Taking
 * stderr first and falling back to the *last* stdout line gets the sentence that
 * names the problem in both cases.
 */
function failureMessage(stdout: string, stderr: string): string {
  const fromStderr = firstLine(stderr);
  if (fromStderr.length > 0) return fromStderr;
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1] ?? "git 执行失败";
}

/** A failed git write, carrying git's own message so the panel can show it. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Run a git command that is expected to succeed, and turn a failure into an
 * error carrying git's own words.
 *
 * Writes are the one place the UI must be honest about what went wrong: "commit
 * failed" without git's reason (no identity configured, nothing staged, a
 * rejected push) would leave the user guessing at a terminal.
 */
async function gitOrThrow(projectPath: string, args: string[], timeout?: number): Promise<string> {
  const result = await git(projectPath, args, timeout === undefined ? {} : { timeout });
  if (!result.ok) {
    const message = failureMessage(result.stdout, result.stderr);
    throw new GitError(message, `${result.stderr.trim()}\n${result.stdout.trim()}`.trim());
  }
  return result.stdout;
}

/** The project-relative paths a write may touch, validated before git sees them. */
function assertPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw badRequest("paths is required");
  }
  const checked: string[] = [];
  for (const value of paths) {
    if (typeof value !== "string" || value.length === 0) {
      throw badRequest("paths must be non-empty strings");
    }
    const segments = assertRelativePath(value);
    if (segments.length === 0) throw forbidden(`路径不能是项目根：${value}`);
    checked.push(segments.join("/"));
  }
  return checked;
}

/**
 * One entry of `git status --porcelain -z`.
 *
 * Two columns, because a file can be changed in the index and in the work tree
 * at once (`MM`, `AM`, …): X is the index, Y the work tree. `-z` gives raw,
 * NUL-separated paths — no quoting to undo, and a path with a newline in it
 * cannot be mistaken for a record boundary.
 */
interface StatusEntry {
  path: string;
  /** X: the index side, or null when this side is unchanged. */
  staged: GitFileStatus | null;
  /** Y: the work tree side, or null when this side is unchanged. */
  unstaged: GitFileStatus | null;
}

/** The status a porcelain column letter stands for, or null for "clean". */
function statusFrom(letter: string, index: boolean): GitFileStatus | null {
  switch (letter) {
    case " ":
    case "?":
      return null;
    case "R":
      return "renamed";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
      return "modified";
    default:
      // `U` in either column, and the `AA`/`DD` pairs read earlier, are the
      // conflict states; anything else git invents is closer to "modified" than
      // to a state this panel knows how to explain.
      return index ? "conflicted" : "modified";
  }
}

function parseStatus(payload: string): StatusEntry[] {
  const records = payload.split("\0");
  const entries: StatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3);

    // A rename/copy record is followed by the original path in its own slot.
    if (x === "R" || x === "C") index += 1;

    if (x === "?" && y === "?") {
      entries.push({ path, staged: null, unstaged: "untracked" });
      continue;
    }
    const conflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    entries.push({
      path,
      staged: conflicted ? "conflicted" : statusFrom(x, true),
      unstaged: conflicted ? "conflicted" : statusFrom(y, false),
    });
  }
  return entries;
}

/** True when a patch carries no text because the file is binary. */
function isBinaryPatch(patch: string): boolean {
  return patch.includes("Binary files ") || patch.includes("GIT binary patch");
}

/** Read one file's patch for one side, honouring the per-file cap. */
async function readPatch(
  projectPath: string,
  path: string,
  staged: boolean,
): Promise<Pick<GitFileEntry, "binary" | "patch" | "truncated">> {
  const args = [
    "diff",
    ...(staged ? ["--cached"] : []),
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "--",
    path,
  ];
  const result = await git(projectPath, args, { maxBuffer: MAX_BUFFER });
  if (!result.ok && result.killed) {
    return { binary: false, patch: "", truncated: true };
  }
  const patch = result.stdout;
  const binary = isBinaryPatch(patch);
  const truncated = patch.length > MAX_PATCH_BYTES;
  return {
    binary,
    patch: binary ? "" : truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch,
    truncated,
  };
}

/** The branch, and whether it is a detached HEAD. */
async function readHead(projectPath: string): Promise<{
  branch: string | null;
  detached: boolean;
  hasHead: boolean;
}> {
  const name = await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const hasHead = (await git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
  if (!name.ok) return { branch: null, detached: false, hasHead };

  const value = name.stdout.trim();
  if (value === "") return { branch: null, detached: false, hasHead };
  if (value !== "HEAD") return { branch: value, detached: false, hasHead };

  const short = await git(projectPath, ["rev-parse", "--short", "HEAD"]);
  return { branch: short.ok ? `HEAD@${short.stdout.trim()}` : "HEAD", detached: true, hasHead };
}

async function readBranches(projectPath: string): Promise<string[]> {
  const result = await git(projectPath, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The branch's push target and how far it has drifted from it. */
async function readUpstream(
  projectPath: string,
): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const name = await git(projectPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!name.ok || name.stdout.trim() === "") return { upstream: null, ahead: 0, behind: 0 };
  const upstream = name.stdout.trim();

  const counts = await git(projectPath, ["rev-list", "--count", "--left-right", "@{u}...HEAD"]);
  if (!counts.ok) return { upstream, ahead: 0, behind: 0 };
  const [behind, ahead] = counts.stdout.trim().split(/\s+/);
  return { upstream, ahead: Number(ahead ?? 0) || 0, behind: Number(behind ?? 0) || 0 };
}

/**
 * The history the panel lists.
 *
 * Fields are separated by ASCII unit/record separators rather than newlines:
 * a commit subject can contain anything, and a `%x1f`-delimited record needs no
 * unquoting.
 */
async function readLog(projectPath: string): Promise<GitLogEntry[]> {
  const format = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e";
  const result = await git(projectPath, [
    "log",
    `--max-count=${String(LOG_LIMIT)}`,
    `--pretty=format:${format}`,
  ]);
  if (!result.ok) return [];

  const entries: GitLogEntry[] = [];
  for (const record of result.stdout.split("\u001e")) {
    if (record.trim().length === 0) continue;
    const [hash, short, subject, author, date, refs] = record.split("\u001f");
    if (hash === undefined || short === undefined) continue;
    entries.push({
      hash,
      short,
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      refs: (refs ?? "")
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0),
    });
  }
  return entries;
}

/**
 * Read the whole changes panel state.
 *
 * `repository: false` is a normal answer for a plain directory, and carries no
 * `error`: the panel says the directory is not a repository instead of showing
 * a failure for a common, non-broken case.
 */
export async function readGitStatus(projectPath: string): Promise<GitStatusView> {
  const inside = await git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    const notARepo = /not a git repository|not a working tree/i.test(inside.stderr);
    return {
      repository: false,
      branch: null,
      detached: false,
      branches: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      omittedFiles: 0,
      log: [],
      ...(notARepo ? {} : { error: firstLine(inside.stderr) || "git 无法运行" }),
    };
  }

  const [head, branches, upstream, status, log] = await Promise.all([
    readHead(projectPath),
    readBranches(projectPath),
    readUpstream(projectPath),
    git(projectPath, ["status", "--porcelain", "-z", "--untracked-files=all"], {
      maxBuffer: 4 * 1024 * 1024,
    }),
    readLog(projectPath),
  ]);

  const entries = parseStatus(status.stdout);
  const staged: GitFileEntry[] = [];
  const unstaged: GitFileEntry[] = [];

  for (const entry of entries.slice(0, MAX_FILES)) {
    if (entry.staged !== null) {
      const patch =
        entry.staged === "conflicted"
          ? { binary: false, patch: "", truncated: false }
          : await readPatch(projectPath, entry.path, true);
      staged.push({ path: entry.path, status: entry.staged, ...patch });
    }
    if (entry.unstaged !== null) {
      // An untracked file has no diff against the index; its content is the
      // whole change, and the Preview tab is where it can be read.
      const patch =
        entry.unstaged === "untracked" || entry.unstaged === "conflicted"
          ? { binary: false, patch: "", truncated: false }
          : await readPatch(projectPath, entry.path, false);
      unstaged.push({ path: entry.path, status: entry.unstaged, ...patch });
    }
  }

  return {
    repository: true,
    branch: head.branch,
    detached: head.detached,
    branches,
    upstream: upstream.upstream,
    ahead: upstream.ahead,
    behind: upstream.behind,
    staged,
    unstaged,
    omittedFiles: Math.max(0, entries.length - MAX_FILES),
    log,
  };
}

/**
 * Stage or unstage paths, then answer with the re-read state.
 *
 * `git add -A` rather than `git add`: `-A` also records a deletion, which is
 * what a user pressing "+" next to a deleted file means. Unstaging uses
 * `git restore --staged`, which exists precisely for this and leaves the work
 * tree alone (unlike `git reset`, which also has other meanings).
 */
export async function gitStage(
  projectPath: string,
  paths: unknown,
  staged: boolean,
): Promise<GitStatusView> {
  const checked = assertPaths(paths);
  const args = staged
    ? ["add", "-A", "--", ...checked]
    : ["restore", "--staged", "--", ...checked];
  await gitOrThrow(projectPath, args);
  return await readGitStatus(projectPath);
}

/** Stage or unstage everything git currently reports as changed. */
export async function gitStageAll(projectPath: string, staged: boolean): Promise<GitStatusView> {
  await gitOrThrow(projectPath, staged ? ["add", "-A"] : ["restore", "--staged", "."]);
  return await readGitStatus(projectPath);
}

/**
 * Commit what is staged.
 *
 * No `-a`: staging is the user's decision, and this button sits next to the
 * staged list. No `--amend` and no `--no-verify` either — both would let the
 * panel do something the user cannot see.
 */
export async function gitCommit(
  projectPath: string,
  message: unknown,
): Promise<{ view: GitStatusView; hash: string }> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw badRequest("提交信息不能为空");
  }
  const output = await gitOrThrow(projectPath, ["commit", "-m", message.trim()], 60_000);
  // The new commit's hash comes from the status, so a hook rewriting history
  // during the commit cannot make the panel show a hash that never existed.
  const view = await readGitStatus(projectPath);
  const hash = view.log[0]?.short ?? firstLine(output);
  return { view, hash };
}

/**
 * Push the current branch.
 *
 * With an upstream it is a plain `git push`; without one it publishes the branch
 * to `origin` (or, failing that, the only configured remote) with `-u`, which is
 * what "push this branch for the first time" means in every git UI. A branch
 * with no remote at all gets a message saying so rather than git's "origin does
 * not appear to be a git repository".
 *
 * Force pushing is never offered: this is the one git write that can destroy
 * someone else's work, and nothing in this panel needs it.
 */
export async function gitPush(
  projectPath: string,
): Promise<{ view: GitStatusView; message: string }> {
  const head = await readHead(projectPath);
  if (head.branch === null) throw new GitError("当前不在任何分支上，无法推送", "");
  if (head.detached) throw new GitError("HEAD 处于游离状态，无法推送", "");

  const before = await readUpstream(projectPath);
  if (before.upstream === null) {
    const remotes = await git(projectPath, ["remote"]);
    const names = remotes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (names.length === 0) throw new GitError("这个仓库没有配置远端，无法推送", "");
    const remote = names.includes("origin") ? "origin" : names[0]!;
    await gitOrThrow(projectPath, ["push", "-u", remote, head.branch], PUSH_TIMEOUT_MS);
    const view = await readGitStatus(projectPath);
    return { view, message: `已推送 ${head.branch} 到 ${remote}，并设为上游。` };
  }

  await gitOrThrow(projectPath, ["push"], PUSH_TIMEOUT_MS);
  const view = await readGitStatus(projectPath);
  const target = view.upstream ?? before.upstream;
  return {
    view,
    message: before.ahead > 0 ? `已推送 ${String(before.ahead)} 个提交到 ${target}。` : `${target} 已是最新。`,
  };
}

/**
 * Throw away the work-tree changes of the given paths.
 *
 * `git restore --worktree` (not `checkout --`) and never `--staged`: discarding
 * is about the file on disk. Untracked files are refused by git itself, and the
 * UI does not offer the action for them — deleting a file git has never seen is
 * not something a "revert" button should quietly do.
 */
export async function gitDiscard(projectPath: string, paths: unknown): Promise<GitStatusView> {
  const checked = assertPaths(paths);
  await gitOrThrow(projectPath, ["restore", "--worktree", "--", ...checked]);
  return await readGitStatus(projectPath);
}

/** Switch to an existing local branch. Creating branches is not offered here. */
export async function gitCheckout(projectPath: string, branch: unknown): Promise<GitStatusView> {
  if (typeof branch !== "string" || branch.trim().length === 0) {
    throw badRequest("branch is required");
  }
  const name = branch.trim();
  // The name is checked against the repository's own branch list rather than
  // against a pattern: `git checkout <rev>` also accepts paths and revisions,
  // and this endpoint is only allowed to mean "switch to this branch".
  const branches = await readBranches(projectPath);
  if (!branches.includes(name)) throw badRequest(`没有这个本地分支：${name}`);
  await gitOrThrow(projectPath, ["checkout", name]);
  return await readGitStatus(projectPath);
}
