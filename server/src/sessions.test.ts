import { mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TITLE_MAX_BYTES } from "./config.ts";

let home: string;
let projectCwd: string;
let otherCwd: string;
let sessionDir: string;
let sessions: typeof import("./sessions.ts");
let projects: typeof import("./projects.ts");
let store: typeof import("./store.ts");
let titles: typeof import("./session-title.ts");

beforeAll(async () => {
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  projectCwd = await realpath(await mkdtemp(join(tmpdir(), "piws-sess-cwd-")));
  otherCwd = await realpath(await mkdtemp(join(tmpdir(), "piws-sess-other-")));
  sessionDir = await realpath(await mkdtemp(join(tmpdir(), "piws-sess-dir-")));
  store = await import("./store.ts");
  projects = await import("./projects.ts");
  sessions = await import("./sessions.ts");
  titles = await import("./session-title.ts");
});

afterAll(async () => {
  for (const dir of [projectCwd, otherCwd, sessionDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await rm(join(home, "store.json"), { force: true });
  store.resetStoreCache();
  for (const name of await readJsonlNames()) {
    await rm(join(sessionDir, name), { force: true });
  }
});

async function readJsonlNames(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

/** Minimal but faithful pi session file: header + optional name + one user message. */
async function writeSession(
  fileName: string,
  options: { id: string; cwd: string; message: string; name?: string; timestamp: string },
): Promise<string> {
  const path = join(sessionDir, fileName);
  const iso = options.timestamp;
  const epoch = Date.parse(iso);
  const rows: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: options.id,
      timestamp: iso,
      cwd: options.cwd,
    }),
  ];
  let parentId: string | null = null;
  if (options.name) {
    rows.push(
      JSON.stringify({
        type: "session_info",
        id: "n1",
        parentId,
        timestamp: iso,
        name: options.name,
      }),
    );
    parentId = "n1";
  }
  rows.push(
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId,
      timestamp: iso,
      message: { role: "user", content: options.message, timestamp: epoch },
    }),
  );
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
  // Pin both clocks: `modified` follows the last entry timestamp, and the file
  // mtime is nudged so a stat-based reader would agree.
  const when = new Date(epoch + 1000);
  await utimes(path, when, when);
  return path;
}

function makeInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const base: SessionInfo = {
    path: "/tmp/session.jsonl",
    id: "0123456789abcdef",
    cwd: "/tmp/project",
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-02T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "first message",
    allMessagesText: "first message",
  };
  return { ...base, ...overrides };
}

describe("toSessionView title precedence", () => {
  it("prefers pi's own session name", () => {
    const view = sessions.toSessionView(makeInfo({ name: "pi name" }), undefined);
    expect(view.title).toBe("pi name");
    expect(view.titleSource).toBe("session");
  });

  it("falls back to the first user message, collapsed", () => {
    const view = sessions.toSessionView(makeInfo({ firstMessage: "  hello\n\n  world  " }), undefined);
    expect(view.title).toBe("hello world");
    expect(view.titleSource).toBe("firstMessage");
  });

  it("uses a stable placeholder when the session is still empty", () => {
    const view = sessions.toSessionView(makeInfo({ firstMessage: "", id: "abcdef1234567890" }), undefined);
    expect(view.title).toBe("Session abcdef12");
    expect(view.titleSource).toBe("fallback");
  });

  it("clips an over-long title within the byte budget", () => {
    const view = sessions.toSessionView(makeInfo({ firstMessage: "x".repeat(200) }), undefined);
    expect(Buffer.byteLength(view.title, "utf8")).toBeLessThanOrEqual(TITLE_MAX_BYTES);
    expect(view.title.endsWith("…")).toBe(true);
  });

  it("keeps only the leading words of a long first message", () => {
    const view = sessions.toSessionView(
      makeInfo({ firstMessage: "one two three four five six seven eight nine ten" }),
      undefined,
    );
    expect(view.title).toBe("one two three four five six seven eight…");
  });

  it("marks the session hidden from the override flag", () => {
    expect(sessions.toSessionView(makeInfo(), { hidden: true }).hidden).toBe(true);
    expect(sessions.toSessionView(makeInfo(), undefined).hidden).toBe(false);
  });

  it("folds an expanded skill command back to what the user typed", () => {
    const firstMessage = [
      '<skill name="git-commit" location="/home/user/.agents/skills/git-commit/SKILL.md">',
      "References are relative to /home/user/.agents/skills/git-commit.",
      "",
      "# Git Commit",
      "",
      "Create a well-crafted git commit.",
      "</skill>",
    ].join("\n");
    const view = sessions.toSessionView(makeInfo({ firstMessage }), undefined);
    expect(view.title).toBe("/skill:git-commit");
    expect(view.preview).toBe("/skill:git-commit");
  });

  it("keeps the arguments the user passed to the skill", () => {
    const firstMessage = [
      '<skill name="git-commit" location="/x/SKILL.md">',
      "body",
      "</skill>",
      "",
      "fix the typo",
    ].join("\n");
    expect(sessions.toSessionView(makeInfo({ firstMessage }), undefined).title).toBe(
      "/skill:git-commit fix the typo",
    );
  });

  it("folds a skill command that pi already clipped", () => {
    const clipped = '<skill name="git-commit" location="/home/user/.agents/skills/git-commit/SKILL…';
    expect(sessions.toSessionView(makeInfo({ firstMessage: clipped }), undefined).title).toBe(
      "/skill:git-commit",
    );
  });
});

describe("listSessions", () => {
  it("returns only sessions whose header cwd matches the project", async () => {
    await writeSession("match.jsonl", {
      id: "11111111-1111-1111-1111-111111111111",
      cwd: projectCwd,
      message: "belongs here",
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    await writeSession("other.jsonl", {
      id: "22222222-2222-2222-2222-222222222222",
      cwd: otherCwd,
      message: "different project",
      timestamp: "2026-02-02T00:00:00.000Z",
    });

    const { sessions: list } = await sessions.listSessions(projectCwd, { sessionDir });
    expect(list.map((s) => s.title)).toEqual(["belongs here"]);
  });

  it("orders by last modified, newest first", async () => {
    await writeSession("older.jsonl", {
      id: "33333333-3333-3333-3333-333333333333",
      cwd: projectCwd,
      message: "older",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await writeSession("newer.jsonl", {
      id: "44444444-4444-4444-4444-444444444444",
      cwd: projectCwd,
      message: "newer",
      timestamp: "2026-03-01T00:00:00.000Z",
    });

    const { sessions: list } = await sessions.listSessions(projectCwd, { sessionDir });
    expect(list.map((s) => s.title)).toEqual(["newer", "older"]);
  });

  it("drops hidden sessions unless explicitly requested", async () => {
    const path = await writeSession("hide-me.jsonl", {
      id: "55555555-5555-5555-5555-555555555555",
      cwd: projectCwd,
      message: "hide me",
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    await projects.setSessionOverride(path, { hidden: true });

    expect((await sessions.listSessions(projectCwd, { sessionDir })).sessions).toHaveLength(0);
    const all = await sessions.listSessions(projectCwd, { sessionDir, includeHidden: true });
    expect(all.sessions).toHaveLength(1);
    expect(all.sessions[0]?.hidden).toBe(true);
  });

  /**
   * A rename now goes into pi's own file (see `session-title.test.ts`). A name
   * left in `store.json` by an older build is still parsed, so the one-time
   * migration can find it — but it must not decide the title any more.
   */
  it("ignores a legacy override name", async () => {
    const path = await writeSession("legacy-rename.jsonl", {
      id: "66666666-6666-6666-6666-666666666666",
      cwd: projectCwd,
      message: "original first message",
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    await writeFile(
      join(home, "store.json"),
      JSON.stringify({
        version: 1,
        projects: [],
        sessionOverrides: { [path]: { name: "Web renamed" } },
      }),
      "utf8",
    );
    store.resetStoreCache();

    const { sessions: list } = await sessions.listSessions(projectCwd, { sessionDir });
    expect(list[0]?.title).toBe("original first message");
    expect(list[0]?.titleSource).toBe("firstMessage");
  });

  /** The whole point of writing into pi's file: pi itself reads it back. */
  it("reads back a name written through the rename path", async () => {
    const path = await writeSession("renamed.jsonl", {
      id: "77777777-7777-7777-7777-777777777777",
      cwd: projectCwd,
      message: "original first message",
      timestamp: "2026-02-01T00:00:00.000Z",
    });

    await titles.setSessionTitle(path, "Web renamed", undefined);

    const { sessions: list } = await sessions.listSessions(projectCwd, { sessionDir });
    expect(list[0]?.title).toBe("Web renamed");
    expect(list[0]?.titleSource).toBe("session");
  });

  it("returns an empty page for a directory with no sessions", async () => {
    expect(await sessions.listSessions(projectCwd, { sessionDir })).toEqual({
      sessions: [],
      total: 0,
    });
  });

  it("returns one page and the total it was cut from", async () => {
    const first = await writeSession("page-1.jsonl", {
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      cwd: projectCwd,
      message: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await writeSession("page-2.jsonl", {
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      cwd: projectCwd,
      message: "second",
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    await writeSession("page-3.jsonl", {
      id: "cccccccc-3333-3333-3333-333333333333",
      cwd: projectCwd,
      message: "third",
      timestamp: "2026-03-01T00:00:00.000Z",
    });

    const page = await sessions.listSessions(projectCwd, { sessionDir, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.sessions.map((s) => s.title)).toEqual(["third", "second"]);

    // The session being read comes along even when it sorts past the cut, so a
    // sidebar that only drew the first row still knows its title.
    const focused = await sessions.listSessions(projectCwd, {
      sessionDir,
      limit: 2,
      focus: first,
    });
    expect(focused.total).toBe(3);
    expect(focused.sessions.map((s) => s.title)).toEqual(["third", "second", "first"]);
  });

  it("parses a directory once and re-reads it after a file moves", async () => {
    const parsed = vi.spyOn(SessionManager, "list");
    try {
      await writeSession("cache-1.jsonl", {
        id: "dddddddd-4444-4444-4444-444444444444",
        cwd: projectCwd,
        message: "cached",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      parsed.mockClear();

      await sessions.listSessions(projectCwd, { sessionDir });
      const second = await sessions.listSessions(projectCwd, { sessionDir, limit: 1 });
      expect(parsed).toHaveBeenCalledTimes(1);
      expect(second.sessions.map((s) => s.title)).toEqual(["cached"]);

      await writeSession("cache-2.jsonl", {
        id: "eeeeeeee-5555-5555-5555-555555555555",
        cwd: projectCwd,
        message: "fresh",
        timestamp: "2026-06-01T00:00:00.000Z",
      });
      const third = await sessions.listSessions(projectCwd, { sessionDir });
      expect(parsed).toHaveBeenCalledTimes(2);
      expect(third.sessions.map((s) => s.title)).toEqual(["fresh", "cached"]);
    } finally {
      parsed.mockRestore();
    }
  });
});
