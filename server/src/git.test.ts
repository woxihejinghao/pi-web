import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitPush,
  gitStage,
  gitStageAll,
  readGitStatus,
} from "./git.ts";

const run = promisify(execFile);

let root: string;

/** Run git in a fixture repository, with an identity that needs no config. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { encoding: "utf8" },
  );
  return stdout;
}

async function initRepo(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, "-c", "init.defaultBranch=main", "init", "-q");
  return path;
}

/** A repository with one commit, ready for the case under test. */
async function repoWithCommit(name: string, files: Record<string, string> = { "a.txt": "one\n" }) {
  const path = await initRepo(name);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(path, file), content, "utf8");
  }
  await git(path, "add", "-A");
  await git(path, "commit", "-qm", "init");
  return path;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "piws-git-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readGitStatus", () => {
  it("reports a plain directory as not a repository, without an error", async () => {
    const path = join(root, "plain");
    await mkdir(path, { recursive: true });
    const view = await readGitStatus(path);
    expect(view).toMatchObject({
      repository: false,
      branch: null,
      staged: [],
      unstaged: [],
      log: [],
    });
    expect(view.error).toBeUndefined();
  });

  it("separates what is staged from what is not", async () => {
    const repo = await repoWithCommit("staging");
    await writeFile(join(repo, "a.txt"), "one\nstaged\n", "utf8");
    await git(repo, "add", "a.txt");

    const staged = await readGitStatus(repo);
    expect(staged.staged.map((file) => file.path)).toEqual(["a.txt"]);
    expect(staged.unstaged).toEqual([]);
    expect(staged.staged[0]?.patch).toContain("+staged");

    // A further edit puts the same path in both lists — the `MM` case, which one
    // combined `diff HEAD` could not tell apart.
    await writeFile(join(repo, "a.txt"), "one\nstaged\nand more\n", "utf8");
    const both = await readGitStatus(repo);
    expect(both.staged.map((file) => file.path)).toEqual(["a.txt"]);
    expect(both.unstaged.map((file) => file.path)).toEqual(["a.txt"]);
    expect(both.staged[0]?.patch).toContain("+staged");
    expect(both.unstaged[0]?.patch).toContain("+and more");
  });

  it("lists an untracked file on the unstaged side, with no patch", async () => {
    const repo = await repoWithCommit("untracked");
    await writeFile(join(repo, "fresh.txt"), "new\n", "utf8");
    const view = await readGitStatus(repo);
    const file = view.unstaged.find((entry) => entry.path === "fresh.txt");
    expect(file).toMatchObject({ status: "untracked", patch: "", binary: false });
    expect(view.staged).toEqual([]);
  });

  it("marks a binary file instead of returning its patch", async () => {
    const repo = await repoWithCommit("binary", { "logo.bin": "x" });
    await writeFile(join(repo, "logo.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const view = await readGitStatus(repo);
    expect(view.unstaged[0]).toMatchObject({ path: "logo.bin", binary: true, patch: "" });
  });

  it("lists the history newest first, with refs and author", async () => {
    const repo = await repoWithCommit("log");
    await writeFile(join(repo, "b.txt"), "b\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "second commit");

    const view = await readGitStatus(repo);
    expect(view.log).toHaveLength(2);
    expect(view.log[0]).toMatchObject({ subject: "second commit", author: "Test" });
    expect(view.log[0]?.short).toHaveLength(7);
    expect(view.log[0]?.refs.join(" ")).toContain("HEAD -> main");
    expect(view.log[1]?.subject).toBe("init");
  });

  it("lists local branches and the push target", async () => {
    const repo = await repoWithCommit("branches");
    await git(repo, "branch", "feature/x");
    const view = await readGitStatus(repo);
    expect(view.branches).toEqual(expect.arrayContaining(["main", "feature/x"]));
    expect(view.branch).toBe("main");
    expect(view.upstream).toBeNull();
    expect(view.ahead).toBe(0);
  });

  it("counts how far the branch is from its upstream", async () => {
    const remote = join(root, "remote-ahead.git");
    await git(root, "-c", "init.defaultBranch=main", "init", "--bare", "-q", remote);
    const repo = await repoWithCommit("ahead");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-qu", "origin", "main");

    const clean = await readGitStatus(repo);
    expect(clean.upstream).toBe("origin/main");
    expect(clean).toMatchObject({ ahead: 0, behind: 0 });

    await writeFile(join(repo, "c.txt"), "c\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "local only");
    const ahead = await readGitStatus(repo);
    expect(ahead.ahead).toBe(1);
    expect(ahead.behind).toBe(0);
  });
});

describe("staging", () => {
  it("stages and unstages one path", async () => {
    const repo = await repoWithCommit("stage-one");
    await writeFile(join(repo, "a.txt"), "changed\n", "utf8");

    const staged = await gitStage(repo, ["a.txt"], true);
    expect(staged.staged.map((file) => file.path)).toEqual(["a.txt"]);
    expect(staged.unstaged).toEqual([]);

    const back = await gitStage(repo, ["a.txt"], false);
    expect(back.staged).toEqual([]);
    expect(back.unstaged.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("records a deletion as a staged change", async () => {
    const repo = await repoWithCommit("stage-delete");
    await rm(join(repo, "a.txt"));
    const staged = await gitStage(repo, ["a.txt"], true);
    expect(staged.staged[0]).toMatchObject({ path: "a.txt", status: "deleted" });
  });

  it("stages everything with one call", async () => {
    const repo = await repoWithCommit("stage-all");
    await writeFile(join(repo, "a.txt"), "changed\n", "utf8");
    await writeFile(join(repo, "new.txt"), "new\n", "utf8");
    const view = await gitStageAll(repo, true);
    expect(view.staged.map((file) => file.path)).toEqual(["a.txt", "new.txt"]);
    expect(view.unstaged).toEqual([]);
  });

  it("refuses a path that leaves the work tree", async () => {
    const repo = await repoWithCommit("stage-escape");
    await expect(gitStage(repo, ["../outside.txt"], true)).rejects.toThrow(/\.\./);
    await expect(gitStage(repo, ["/etc/passwd"], true)).rejects.toThrow(/相对路径/);
    await expect(gitStage(repo, [], true)).rejects.toThrow(/paths is required/);
  });
});

describe("commit", () => {
  it("commits what is staged and answers with the new state", async () => {
    const repo = await repoWithCommit("commit");
    await writeFile(join(repo, "a.txt"), "one\ncommitted\n", "utf8");
    await git(repo, "add", "a.txt");

    const { view, hash } = await gitCommit(repo, "feat: add a line");
    expect(view.log[0]?.subject).toBe("feat: add a line");
    expect(view.staged).toEqual([]);
    expect(view.unstaged).toEqual([]);
    expect(hash).toBe(view.log[0]?.short);
  });

  it("commits only what is staged, leaving the rest in the work tree", async () => {
    const repo = await repoWithCommit("commit-partial");
    await writeFile(join(repo, "a.txt"), "one\nstaged\n", "utf8");
    await git(repo, "add", "a.txt");
    await writeFile(join(repo, "b.txt"), "unstaged\n", "utf8");

    const { view } = await gitCommit(repo, "only a.txt");
    expect(view.unstaged.map((file) => file.path)).toEqual(["b.txt"]);
  });

  it("rejects an empty message and reports git's own refusal", async () => {
    const repo = await repoWithCommit("commit-empty");
    await expect(gitCommit(repo, "   ")).rejects.toThrow(/提交信息不能为空/);
    // Nothing staged: git's message is what the user has to see.
    await expect(gitCommit(repo, "nothing to commit")).rejects.toBeInstanceOf(GitError);
  });
});

describe("discard", () => {
  it("restores a modified file to HEAD", async () => {
    const repo = await repoWithCommit("discard");
    await writeFile(join(repo, "a.txt"), "thrown away\n", "utf8");
    const view = await gitDiscard(repo, ["a.txt"]);
    expect(view.unstaged).toEqual([]);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });

  it("refuses an untracked file rather than deleting it", async () => {
    const repo = await repoWithCommit("discard-untracked");
    await writeFile(join(repo, "fresh.txt"), "keep me\n", "utf8");
    await expect(gitDiscard(repo, ["fresh.txt"])).rejects.toBeInstanceOf(GitError);
    expect(await readFile(join(repo, "fresh.txt"), "utf8")).toBe("keep me\n");
  });
});

describe("push", () => {
  it("publishes a branch that has no upstream yet", async () => {
    const remote = join(root, "remote-publish.git");
    await git(root, "-c", "init.defaultBranch=main", "init", "--bare", "-q", remote);
    const repo = await repoWithCommit("publish");
    await git(repo, "remote", "add", "origin", remote);

    const { view, message } = await gitPush(repo);
    expect(message).toContain("已推送 main 到 origin");
    expect(view.upstream).toBe("origin/main");
    expect(view).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("pushes new commits and reports how many", async () => {
    const remote = join(root, "remote-more.git");
    await git(root, "-c", "init.defaultBranch=main", "init", "--bare", "-q", remote);
    const repo = await repoWithCommit("push-more");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-qu", "origin", "main");

    await writeFile(join(repo, "d.txt"), "d\n", "utf8");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "more");

    const { view, message } = await gitPush(repo);
    expect(message).toContain("已推送 1 个提交");
    expect(view.ahead).toBe(0);
  });

  it("says so when there is nothing to push", async () => {
    const remote = join(root, "remote-noop.git");
    await git(root, "-c", "init.defaultBranch=main", "init", "--bare", "-q", remote);
    const repo = await repoWithCommit("push-noop");
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-qu", "origin", "main");

    const { message } = await gitPush(repo);
    expect(message).toContain("已是最新");
  });

  it("explains a repository with no remote instead of leaking git's wording", async () => {
    const repo = await repoWithCommit("push-no-remote");
    await expect(gitPush(repo)).rejects.toThrow(/没有配置远端/);
  });
});

describe("checkout", () => {
  it("switches to an existing local branch", async () => {
    const repo = await repoWithCommit("checkout");
    await git(repo, "branch", "feature");
    const view = await gitCheckout(repo, "feature");
    expect(view.branch).toBe("feature");
  });

  it("refuses a branch that does not exist", async () => {
    const repo = await repoWithCommit("checkout-missing");
    await expect(gitCheckout(repo, "nope")).rejects.toThrow(/没有这个本地分支/);
    // Nothing else may be smuggled in through this endpoint.
    await expect(gitCheckout(repo, "HEAD~1")).rejects.toThrow(/没有这个本地分支/);
  });
});
