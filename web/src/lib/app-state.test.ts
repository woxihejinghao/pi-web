import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Interface copy resolves through `useT`, and the default `system` preference
// lands on English without a navigator (node test environment). The assertions
// below pin the Chinese wording, so fix the host locale here.
vi.stubGlobal("navigator", { language: "zh-CN" });
import { api } from "./api.ts";
import { APP_NAME } from "./brand.ts";
import {
  actions,
  appStore,
  commandsKey,
  isDraftSession,
  resetAppState,
  DRAFT_PREFIX,
} from "./app-state.ts";
import type { ExtensionUiRequest, ProjectView, SessionView } from "./types.ts";
import { DEFAULT_PRESET_ID } from "./types.ts";

vi.mock("./api.ts", () => ({
  api: {
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    listPresets: vi.fn(),
    prewarmSession: vi.fn(),
    addProject: vi.fn(),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    renameSession: vi.fn(),
    setSessionHidden: vi.fn(),
    deleteSession: vi.fn(),
    listCommands: vi.fn(),
    listUiRequests: vi.fn(),
    env: vi.fn(),
    reorderProjects: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

type CreatedSession = Awaited<ReturnType<typeof api.createSession>>;

/** A create request we resolve by hand, so spawn latency is under our control. */
function deferredCreate() {
  let resolve!: (value: CreatedSession) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<CreatedSession>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  mocked.createSession.mockReturnValue(promise);
  return { resolve, reject };
}

const REAL_PATH = "/home/me/.pi/agent/sessions/proj-abc/one.jsonl";

/** A session as the server would report it, i.e. one that is already on disk. */
function diskSession(path: string, title = "one"): SessionView {
  return {
    path,
    id: path,
    cwd: "/home/me/proj",
    title,
    titleSource: "session",
    preview: "",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    hidden: false,
  };
}

/**
 * A stand-in for the browser API, capturing every construction. Only the parts
 * `notifications.ts` touches are here: the permission, the constructor, and the
 * click handler it wires up.
 */
const shownNotifications: FakeNotification[] = [];

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
  onclick: (() => void) | null = null;
  close = vi.fn();
  readonly title: string;
  readonly options?: NotificationOptions;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    shownNotifications.push(this);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAppState();
  mocked.listProjects.mockResolvedValue([]);
  mocked.listSessions.mockResolvedValue({ sessions: [], total: 0 });
  mocked.prewarmSession.mockResolvedValue({ ok: true, projectPath: "/home/me/proj" });
  mocked.listCommands.mockResolvedValue({ commands: [] });
  mocked.listUiRequests.mockResolvedValue({ requests: [] });
  mocked.env.mockResolvedValue({ home: "/home/me" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("draft sessions", () => {
  it("selects a draft path synchronously, before any request resolves", () => {
    deferredCreate();
    actions.startDraftSession("project-1");

    const selected = appStore.get().selectedSessionPath;
    expect(selected).not.toBeNull();
    expect(isDraftSession(selected)).toBe(true);
    expect(selected?.startsWith(DRAFT_PREFIX)).toBe(true);
  });

  it("swaps in the real path once the spawn resolves", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");
    expect(isDraftSession(appStore.get().selectedSessionPath)).toBe(true);

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(isDraftSession(appStore.get().selectedSessionPath)).toBe(false);
  });

  it("remembers which workspace owns the draft until its file lands", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    const draft = appStore.get().selectedSessionPath!;
    expect(isDraftSession(draft)).toBe(true);
    expect(appStore.get().unsavedSessions).toEqual({ "project-1": [draft] });

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    // The draft id is swapped for the real path in place: the session stays
    // tracked under project-1 until the disk list includes it, which is what
    // keeps its row in the sidebar when the user looks elsewhere.
    expect(appStore.get().unsavedSessions).toEqual({ "project-1": [REAL_PATH] });
  });

  it("addresses a dialog that arrived before the session had a file", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    // The extension asks in the window before pi names its session file
    // (`session_start` lands ahead of `get_state`), so the request reaches this
    // tab addressed to nobody — and it can only be this session's: the draft on
    // screen is the only session being created.
    const asked = { type: "extension_ui_request" as const, id: "ui_1", method: "confirm" };
    actions.enqueueUiRequest({ sessionPath: "", request: asked });

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    // The path is written onto it with the swap, so the card the draft is
    // holding on to stays in the composer seat instead of being read as some
    // other session's dialog.
    await vi.waitFor(() => {
      expect(appStore.get().pendingUiRequests).toEqual([
        { sessionPath: REAL_PATH, request: asked },
      ]);
    });
  });

  it("keeps a running session tracked after the user moves on", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    // The user navigates to another conversation while the spawn is in flight.
    actions.selectSession("/home/me/.pi/agent/sessions/proj-abc/other.jsonl");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await vi.waitFor(() => {
      expect(appStore.get().unsavedSessions).toEqual({ "project-1": [REAL_PATH] });
    });
    expect(appStore.get().selectedSessionPath).toBe(
      "/home/me/.pi/agent/sessions/proj-abc/other.jsonl",
    );
  });

  it("tracks each session started in a workspace separately", () => {
    mocked.createSession.mockResolvedValue({
      sessionPath: REAL_PATH,
      sessionId: "s1",
      projectPath: "/home/me/proj",
      prewarmed: false,
      presetId: "standard",
    });
    actions.startDraftSession("project-1");
    const first = appStore.get().selectedSessionPath!;
    actions.startDraftSession("project-1");

    expect(appStore.get().unsavedSessions["project-1"]).toHaveLength(2);
    expect(appStore.get().unsavedSessions["project-1"]).toContain(first);
  });

  it("stops tracking a session once the disk list includes it", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });
    await vi.waitFor(() => {
      expect(appStore.get().unsavedSessions).toEqual({ "project-1": [REAL_PATH] });
    });

    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await actions.refreshSessions("project-1");

    expect(appStore.get().unsavedSessions).toEqual({ "project-1": [] });
  });

  it("forgets a session whose process closed without a file", () => {
    deferredCreate();
    actions.startDraftSession("project-1");
    const draft = appStore.get().selectedSessionPath!;

    actions.forgetUnsavedSession(draft);

    expect(appStore.get().unsavedSessions["project-1"]).toEqual([]);
  });

  it("does not steal selection back if the user moved on", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    // The user navigates to another conversation while the spawn is in flight.
    actions.selectSession("/home/me/.pi/agent/sessions/proj-abc/other.jsonl");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appStore.get().selectedSessionPath).toBe(
      "/home/me/.pi/agent/sessions/proj-abc/other.jsonl",
    );
  });

  it("clears the selection and reports a failure when the spawn fails", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    create.reject(new Error("pi rpc failed: boom"));

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBeNull();
    });
    // No process, no file, nothing to open: the row goes with the failure.
    expect(appStore.get().unsavedSessions["project-1"]).toEqual([]);
    expect(appStore.get().notice).toBe("pi rpc failed: boom");
  });

  it("resolveDraftSession returns the real path", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await expect(actions.resolveDraftSession()).resolves.toBe(REAL_PATH);
  });

  it("resolveDraftSession is null when nothing was started", async () => {
    await expect(actions.resolveDraftSession()).resolves.toBeNull();
  });
});

describe("background session persistence", () => {
  it("names the pending row on the first user frame without waiting for an assistant", async () => {
    appStore.update((state) => ({
      ...state,
      selectedProjectId: "other-project",
      selectedSessionPath: "/other/session.jsonl",
      unsavedSessions: { "project-1": [REAL_PATH] },
    }));
    actions.emitSessionEvent(REAL_PATH, {
      type: "message_start", message: { role: "user", content: [{ type: "text", text: "修复登录问题" }] },
    });
    expect(appStore.get().unsavedSessionTitles[REAL_PATH]).toBe("修复登录问题");
    expect(appStore.get().unsavedSessions["project-1"]).toEqual([REAL_PATH]);
    expect(appStore.get().selectedSessionPath).toBe("/other/session.jsonl");
    expect(mocked.listSessions).not.toHaveBeenCalled();

    actions.emitSessionEvent(REAL_PATH, {
      type: "message_end", message: { role: "user", content: "another message" },
    });
    await actions.refreshSessions("project-1", { force: true });
    expect(appStore.get().unsavedSessionTitles[REAL_PATH]).toBe("修复登录问题");

    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH, "正式标题")], total: 1 });
    await actions.refreshSessions("project-1", { force: true });
    expect(appStore.get().unsavedSessionTitles[REAL_PATH]).toBeUndefined();
    expect(appStore.get().sessions["project-1"]?.[0]?.title).toBe("正式标题");
  });

  it("bounds pending titles and cleans them up when the session closes", () => {
    appStore.update((state) => ({ ...state, unsavedSessions: { "project-1": [REAL_PATH] } }));
    actions.noteUnsavedSessionTitle(REAL_PATH, "中文😀".repeat(100));
    const title = appStore.get().unsavedSessionTitles[REAL_PATH]!;
    expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("�");
    actions.forgetUnsavedSession(REAL_PATH);
    expect(appStore.get().unsavedSessionTitles[REAL_PATH]).toBeUndefined();
  });

  it("does not replace persisted or manually named rows with a user message", () => {
    appStore.update((state) => ({
      ...state, sessions: { "project-1": [diskSession(REAL_PATH, "手动命名")] },
      unsavedSessions: { "project-1": [REAL_PATH] },
    }));
    actions.noteUnsavedSessionTitle(REAL_PATH, "hello");
    expect(appStore.get().unsavedSessionTitles[REAL_PATH]).toBeUndefined();
    expect(appStore.get().sessions["project-1"]?.[0]?.title).toBe("手动命名");
  });
  it("replaces an unsaved row and its title in the owning workspace after switching away", async () => {
    appStore.update((state) => ({
      ...state,
      selectedProjectId: "other-project",
      selectedSessionPath: "/other/session.jsonl",
      sessions: { "project-1": [] },
      unsavedSessions: { "project-1": [REAL_PATH] },
    }));
    mocked.listSessions.mockResolvedValue({
      sessions: [diskSession(REAL_PATH, "修复登录问题")], total: 1,
    });

    actions.emitSessionEvent(REAL_PATH, {
      type: "message_end", message: { role: "assistant", content: [] },
    });

    await vi.waitFor(() => {
      expect(appStore.get().unsavedSessions["project-1"]).toEqual([]);
    });
    expect(mocked.listSessions).toHaveBeenCalledWith("project-1", expect.any(Object));
    expect(appStore.get().sessions["project-1"]?.[0]?.title).toBe("修复登录问题");
    expect(appStore.get().selectedSessionPath).toBe("/other/session.jsonl");
    expect(appStore.get().selectedProjectId).toBe("other-project");
  });

  it("retries persistence on settle if the first message still preceded the disk flush", async () => {
    appStore.update((state) => ({
      ...state,
      unsavedSessions: { "project-1": [REAL_PATH] },
    }));
    actions.emitSessionEvent(REAL_PATH, {
      type: "message_end", message: { role: "assistant", content: [] },
    });
    await vi.waitFor(() => expect(mocked.listSessions).toHaveBeenCalledTimes(1));
    expect(appStore.get().unsavedSessions["project-1"]).toEqual([REAL_PATH]);

    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 1 });
    actions.emitSessionEvent(REAL_PATH, { type: "agent_settled" });
    await vi.waitFor(() => expect(appStore.get().unsavedSessions["project-1"]).toEqual([]));
  });

  it("does not refetch for tokens, user messages, or assistant messages already on disk", () => {
    appStore.update((state) => ({
      ...state, sessions: { "project-1": [diskSession(REAL_PATH)] },
    }));
    actions.emitSessionEvent(REAL_PATH, { type: "message_update" });
    actions.emitSessionEvent(REAL_PATH, {
      type: "message_end", message: { role: "user", content: "hello" },
    });
    actions.emitSessionEvent(REAL_PATH, {
      type: "message_end", message: { role: "assistant", content: [] },
    });
    expect(mocked.listSessions).not.toHaveBeenCalled();
  });
});

describe("pending prompts", () => {
  it("hands the text to the session that replaced the draft", () => {
    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    expect(actions.takePendingPrompt(REAL_PATH)).toEqual({
      sessionPath: REAL_PATH,
      text: "hello",
      mode: "prompt",
    });
  });

  it("carries the command flag across the queue", () => {
    // pi records only what an extension command submits itself, so a queued
    // command has to arrive as one — otherwise the session draws the typed line
    // as a user turn nothing ever wrote.
    actions.queuePendingPrompt(REAL_PATH, "/plan", "prompt", [], true);
    expect(actions.takePendingPrompt(REAL_PATH)).toMatchObject({ text: "/plan", command: true });

    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    expect(actions.takePendingPrompt(REAL_PATH)?.command).toBeUndefined();
  });

  it("consumes the prompt only once", () => {
    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    expect(actions.takePendingPrompt(REAL_PATH)).not.toBeNull();
    expect(actions.takePendingPrompt(REAL_PATH)).toBeNull();
  });

  it("ignores a prompt addressed to a different session", () => {
    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    expect(actions.takePendingPrompt("/somewhere/else.jsonl")).toBeNull();
    // The original is still queued for its own session.
    expect(appStore.get().pendingPrompt?.text).toBe("hello");
  });

  it("is dropped when the user switches conversations", () => {
    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    actions.selectSession("/somewhere/else.jsonl");
    expect(appStore.get().pendingPrompt).toBeNull();
  });

  it("is dropped when the user switches projects", async () => {
    actions.queuePendingPrompt(REAL_PATH, "hello", "prompt");
    await actions.selectProject("project-2");
    expect(appStore.get().pendingPrompt).toBeNull();
  });

  it("is dropped when a new draft starts", () => {
    actions.queuePendingPrompt(REAL_PATH, "stale", "prompt");
    deferredCreate();
    actions.startDraftSession("project-1");
    expect(appStore.get().pendingPrompt).toBeNull();
  });
});

describe("extension dialogs", () => {
  const dialog = (sessionPath: string, id: string): { sessionPath: string; request: ExtensionUiRequest } => ({
    sessionPath,
    request: { type: "extension_ui_request", id, method: "select", options: ["allow", "block"] },
  });

  it("keeps a second request instead of overwriting the first", () => {
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_1"));
    actions.enqueueUiRequest(dialog("/other.jsonl", "ui_2"));
    expect(appStore.get().pendingUiRequests.map((item) => item.request.id)).toEqual([
      "ui_1",
      "ui_2",
    ]);
  });

  it("ignores a request that is already queued", () => {
    const first = dialog(REAL_PATH, "ui_1");
    actions.enqueueUiRequest(first);
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_1"));
    expect(appStore.get().pendingUiRequests).toHaveLength(1);
  });

  it("dismisses only the request that was answered", () => {
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_1"));
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_2"));
    actions.dismissUiRequest("ui_1");
    expect(appStore.get().pendingUiRequests.map((item) => item.request.id)).toEqual(["ui_2"]);
  });

  it("keeps one entry for a dialog whose session path only arrives later", () => {
    // A fresh session has no path when its extension asks, so the same uuid is
    // delivered twice: once with an empty path, once with the real one.
    actions.enqueueUiRequest(dialog("", "ui_1"));
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_1"));
    expect(appStore.get().pendingUiRequests).toEqual([dialog(REAL_PATH, "ui_1")]);
  });

  it("does not demote a resolved path back to an empty one", () => {
    actions.enqueueUiRequest(dialog(REAL_PATH, "ui_1"));
    actions.enqueueUiRequest(dialog("", "ui_1"));
    expect(appStore.get().pendingUiRequests).toEqual([dialog(REAL_PATH, "ui_1")]);
  });

  it("adopts the dialogs the server held across a reload", async () => {
    // A session with no path yet is the case that matters: pi only reports its
    // file after the question has already been asked.
    mocked.listUiRequests.mockResolvedValue({ requests: [dialog("", "ui_1")] });
    await actions.loadPendingUiRequests();
    expect(appStore.get().pendingUiRequests).toEqual([dialog("", "ui_1")]);
  });

  it("does not drop a dialog that arrived while the list was in flight", async () => {
    mocked.listUiRequests.mockImplementation(async () => {
      actions.enqueueUiRequest(dialog("/other.jsonl", "ui_2"));
      return { requests: [dialog(REAL_PATH, "ui_1")] };
    });
    await actions.loadPendingUiRequests();
    expect(appStore.get().pendingUiRequests.map((item) => item.request.id)).toEqual([
      "ui_2",
      "ui_1",
    ]);
  });
});

describe("prewarming", () => {
  it("warms a session when a project is selected", async () => {
    await actions.selectProject("project-1");
    expect(mocked.prewarmSession).toHaveBeenCalledWith("project-1");
  });

  it("warms the first project on bootstrap", async () => {
    const project: ProjectView = {
      id: "project-1",
      path: "/home/me/proj",
      title: "proj",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      exists: true,
    };
    mocked.listProjects.mockResolvedValue([project]);

    await actions.bootstrap();

    expect(mocked.prewarmSession).toHaveBeenCalledWith("project-1");
  });

  it("boots with every workspace folded", async () => {
    const project: ProjectView = {
      id: "project-1",
      path: "/home/me/proj",
      title: "proj",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      exists: true,
    };
    mocked.listProjects.mockResolvedValue([project]);

    await actions.bootstrap();

    // Selecting the first workspace is not the same as opening it: the sidebar
    // starts with every session list closed, even the one that is selected.
    expect(appStore.get().selectedProjectId).toBe("project-1");
    expect(appStore.get().expandedProjects).toEqual({});
  });

  it("loads the host home directory so paths can be shown as ~", async () => {
    mocked.listProjects.mockResolvedValue([]);

    await actions.bootstrap();

    await vi.waitFor(() => expect(appStore.get().home).toBe("/home/me"));
  });

  it("still bootstraps when the home directory is unavailable", async () => {
    // Display-only: losing it must never block first paint or break selection.
    mocked.env.mockRejectedValue(new Error("offline"));
    mocked.listProjects.mockResolvedValue([]);

    await actions.bootstrap();

    expect(appStore.get().status).toBe("ready");
    expect(appStore.get().home).toBe("");
  });

  it("survives a prewarm failure without a notice", async () => {
    mocked.prewarmSession.mockRejectedValue(new Error("boom"));
    await actions.selectProject("project-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appStore.get().notice).toBeNull();
  });
});

describe("slash commands", () => {
  const commands = [{ name: "skill:pdf-tools", description: "PDFs", source: "skill" as const }];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("caches a project's commands after the first load", async () => {
    mocked.listCommands.mockResolvedValue({ commands });
    await actions.loadCommands("project-1");
    expect(appStore.get().commands[commandsKey("project-1", DEFAULT_PRESET_ID)]).toEqual(commands);

    await actions.loadCommands("project-1");
    expect(mocked.listCommands).toHaveBeenCalledTimes(1);
  });

  it("treats an empty list as loaded so it stops re-asking", async () => {
    await actions.loadCommands("project-1");
    await actions.loadCommands("project-1");
    expect(mocked.listCommands).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent loads of the same project", async () => {
    let resolve!: (value: { commands: [] }) => void;
    mocked.listCommands.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }) as never,
    );

    const first = actions.loadCommands("project-1");
    const second = actions.loadCommands("project-1");
    resolve({ commands: [] });
    await Promise.all([first, second]);

    expect(mocked.listCommands).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure, so a retry is possible", async () => {
    mocked.listCommands.mockRejectedValueOnce(new Error("offline"));
    await actions.loadCommands("project-1");
    expect(appStore.get().commands[commandsKey("project-1", DEFAULT_PRESET_ID)]).toBeUndefined();

    await actions.loadCommands("project-1");
    expect(mocked.listCommands).toHaveBeenCalledTimes(2);
  });

  it("keeps per-project results separate", async () => {
    mocked.listCommands.mockResolvedValueOnce({ commands });
    mocked.listCommands.mockResolvedValueOnce({ commands: [] });

    await actions.loadCommands("project-1");
    await actions.loadCommands("project-2");

    expect(appStore.get().commands[commandsKey("project-1", DEFAULT_PRESET_ID)]).toEqual(commands);
    expect(appStore.get().commands[commandsKey("project-2", DEFAULT_PRESET_ID)]).toEqual([]);
  });

  it("keys a listing by composition, not by project", async () => {
    mocked.listCommands.mockResolvedValueOnce({ commands, presetId: "standard" });
    mocked.listCommands.mockResolvedValueOnce({ commands: [], presetId: "minimal" });

    await actions.loadCommands("project-1", "standard");
    await actions.loadCommands("project-1", "minimal");

    // One workspace, two compositions: the minimal one has no skills or
    // templates to offer, and caching both under the project would hide that.
    expect(appStore.get().commands[commandsKey("project-1", "standard")]).toEqual(commands);
    expect(appStore.get().commands[commandsKey("project-1", "minimal")]).toEqual([]);
    expect(mocked.listCommands).toHaveBeenCalledTimes(2);
  });

  it("files an answer under the composition the server named", async () => {
    // A reply that raced a preset change names the composition it answered for;
    // trusting the request instead would leave the menu describing a process
    // this session is not running.
    mocked.listCommands.mockResolvedValueOnce({ commands, presetId: "minimal" });

    await actions.loadCommands("project-1", "standard");

    expect(appStore.get().commands[commandsKey("project-1", "minimal")]).toEqual(commands);
    expect(appStore.get().commands[commandsKey("project-1", "standard")]).toBeUndefined();
  });
});

describe("partial command listings", () => {
  // A listing that came back with the server's `error` is only the built-ins:
  // no pi process answered, so the skills are missing rather than absent. Its
  // retry is a timer, so these run on fake ones.
  const builtins = [{ name: "compact", description: "Compact", source: "builtin" as const }];
  const commands = [{ name: "skill:pdf-tools", description: "PDFs", source: "skill" as const }];
  const key = commandsKey("project-1", DEFAULT_PRESET_ID);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // A partial reply is answered by the built-ins-only branch of the route, so
  // the client keeps it for those but must not read it as "that is everything".
  const partial = { commands: builtins, presetId: DEFAULT_PRESET_ID, error: "no pi process" };

  it("keeps the built-ins but asks again, since the skills were missing", async () => {
    mocked.listCommands.mockResolvedValueOnce(partial);
    await actions.loadCommands("project-1");

    expect(appStore.get().commands[key]).toEqual(builtins);
    expect(appStore.get().commandsPartial[key]).toBe(true);

    // A later ask ignores the cached partial answer, and the full list lands.
    mocked.listCommands.mockResolvedValueOnce({ commands, presetId: DEFAULT_PRESET_ID });
    await actions.loadCommands("project-1");

    expect(mocked.listCommands).toHaveBeenCalledTimes(2);
    expect(appStore.get().commands[key]).toEqual(commands);
    expect(appStore.get().commandsPartial[key]).toBeUndefined();
  });

  it("retries on its own, so a skill list lost at startup comes back", async () => {
    mocked.listCommands
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ commands, presetId: DEFAULT_PRESET_ID });

    await actions.loadCommands("project-1");
    expect(appStore.get().commandsPartial[key]).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.listCommands).toHaveBeenCalledTimes(2);
    expect(appStore.get().commands[key]).toEqual(commands);
    expect(appStore.get().commandsPartial[key]).toBeUndefined();
  });
});

describe("sidebar ui state", () => {
  it("toggles a project's expansion", () => {
    actions.toggleProjectExpanded("p1");
    expect(appStore.get().expandedProjects.p1).toBe(true);
    actions.toggleProjectExpanded("p1");
    expect(appStore.get().expandedProjects.p1).toBeUndefined();
  });

  it("expands a project idempotently, without toggling it shut", () => {
    actions.expandProject("p1");
    expect(appStore.get().expandedProjects.p1).toBe(true);
    actions.expandProject("p1");
    expect(appStore.get().expandedProjects.p1).toBe(true);
  });

  it("keeps the open conversation when a project is selected", async () => {
    actions.selectSession("/some/session.jsonl");
    await actions.selectProject("p1");
    expect(appStore.get().selectedSessionPath).toBe("/some/session.jsonl");
  });

  it("records how many extra sessions are revealed", () => {
    actions.revealMoreSessions("p1", 10);
    expect(appStore.get().revealedSessions.p1).toBe(10);
  });

  it("closes the search and clears it in one step, keeping the query while it is open", () => {
    actions.setSessionQuery("abc");
    actions.openSearch();
    expect(appStore.get().searchOpen).toBe(true);
    // Opening keeps what was typed: the field is the query's only surface, so
    // dropping it here would be dropping something the user can still see.
    expect(appStore.get().sessionQuery).toBe("abc");
    actions.closeSearch();
    expect(appStore.get().searchOpen).toBe(false);
    expect(appStore.get().sessionQuery).toBe("");
  });
});

/**
 * Opening a session moves the selected workspace with it.
 *
 * The header names the selected project and every per-project surface is keyed
 * on it, so a conversation opened from another workspace has to switch that
 * selection. Without this the transcript changed while the header kept naming
 * the workspace the reader had been in before.
 */
describe("session selection follows its workspace", () => {
  const project = (id: string): ProjectView => ({
    id,
    path: `/home/me/${id}`,
    title: id,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  });

  /** Two workspaces, the first selected, with one session under `owner`. */
  const seed = (owner: string, path: string): void => {
    appStore.update((state) => ({
      ...state,
      projects: [project("p1"), project("p2")],
      selectedProjectId: "p1",
      sessions: { ...state.sessions, [owner]: [diskSession(path, "one")] },
    }));
  };

  it("switches the workspace when the open session belongs to another one", () => {
    const owner = "/home/me/.pi/agent/sessions/p2/one.jsonl";
    seed("p2", owner);

    actions.selectSession(owner);

    expect(appStore.get().selectedProjectId).toBe("p2");
    expect(appStore.get().selectedSessionPath).toBe(owner);
  });

  it("reveals the workspace it switches to", () => {
    seed("p2", REAL_PATH);

    actions.selectSession(REAL_PATH);

    expect(appStore.get().expandedProjects.p2).toBe(true);
  });

  it("trusts an owner the loaded lists do not hold", () => {
    // A flat-list row knows the workspace it was drawn under even when that
    // page was never fetched, so the click carries the owner in.
    appStore.update((state) => ({ ...state, selectedProjectId: "p1" }));

    actions.selectSession(REAL_PATH, "p2");

    expect(appStore.get().selectedProjectId).toBe("p2");
  });

  it("keeps the workspace when the session cannot be placed", () => {
    appStore.update((state) => ({ ...state, selectedProjectId: "p1" }));

    actions.selectSession("/unknown/session.jsonl");

    expect(appStore.get().selectedProjectId).toBe("p1");
    expect(appStore.get().selectedSessionPath).toBe("/unknown/session.jsonl");
  });

  it("finds a draft's owner in the unsaved list", () => {
    appStore.update((state) => ({
      ...state,
      projects: [project("p1"), project("p2")],
      selectedProjectId: "p1",
      unsavedSessions: { p2: ["draft:abc"] },
    }));

    actions.selectSession("draft:abc");

    expect(appStore.get().selectedProjectId).toBe("p2");
  });

  it("fetches the page of a workspace that was never loaded", async () => {
    appStore.update((state) => ({
      ...state,
      projects: [project("p1"), project("p2")],
      selectedProjectId: "p1",
    }));
    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 1 });

    actions.selectSession(REAL_PATH, "p2");

    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledWith(
        "p2",
        expect.objectContaining({ focus: REAL_PATH }),
      );
    });
  });
});

/**
 * A workspace's first page is marked in flight while it is being read.
 *
 * The sidebar draws a workspace from `sessions[projectId]` alone, so a read in
 * progress and a workspace that is genuinely empty have the same shape. This is
 * the flag that tells them apart — the workspace row's hint is drawn from it
 * (see `session-rows.ts`), and it has to survive both a failure and a reload
 * that was superseded while it ran.
 */
describe("a workspace's first page is marked in flight", () => {
  const project = (id: string): ProjectView => ({
    id,
    path: `/home/me/${id}`,
    title: id,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  });

  const seed = (): void => {
    appStore.update((state) => ({
      ...state,
      projects: [project("p1")],
      selectedProjectId: "p1",
    }));
  };

  /** A page we answer by hand, so the mark can be read while it is in flight. */
  const deferredPage = () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.listSessions>>) => void;
    const promise = new Promise<Awaited<ReturnType<typeof api.listSessions>>>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  it("marks the workspace until the page lands", async () => {
    seed();
    const page = deferredPage();
    mocked.listSessions.mockReturnValue(page.promise);

    const reading = actions.refreshSessions("p1");
    expect(appStore.get().sessionsLoading.p1).toBe(true);

    page.resolve({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await reading;

    expect(appStore.get().sessionsLoading.p1).toBeUndefined();
    expect(appStore.get().sessions.p1).toHaveLength(1);
  });

  it("clears the mark when the read fails", async () => {
    seed();
    mocked.listSessions.mockRejectedValueOnce(new Error("offline"));

    await actions.refreshSessions("p1");

    // A failed read says nothing about the workspace, so it must not leave a
    // hint running with no answer coming.
    expect(appStore.get().sessionsLoading.p1).toBeUndefined();
    expect(appStore.get().sessions.p1).toBeUndefined();
  });

  it("leaves a workspace that already holds rows unmarked", async () => {
    seed();
    appStore.update((state) => ({
      ...state,
      sessions: { p1: [diskSession(REAL_PATH)] },
      sessionTotals: { p1: 1 },
    }));
    const page = deferredPage();
    mocked.listSessions.mockReturnValue(page.promise);

    const reading = actions.refreshSessions("p1", { force: true });
    expect(appStore.get().sessionsLoading.p1).toBeUndefined();

    page.resolve({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await reading;
    expect(appStore.get().sessionsLoading.p1).toBeUndefined();
  });

  it("does not clear a newer read's mark", async () => {
    seed();
    const first = deferredPage();
    mocked.listSessions.mockReturnValueOnce(first.promise);
    const reading = actions.refreshSessions("p1");
    expect(appStore.get().sessionsLoading.p1).toBe(true);

    // "Show more" is clicked before the first answer lands.
    const second = deferredPage();
    mocked.listSessions.mockReturnValueOnce(second.promise);
    const rereading = actions.refreshSessions("p1", { force: true });
    expect(appStore.get().sessionsLoading.p1).toBe(true);

    first.resolve({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await reading;
    // The dropped answer must not take down the hint its successor is showing.
    expect(appStore.get().sessionsLoading.p1).toBe(true);

    second.resolve({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await rereading;
    expect(appStore.get().sessionsLoading.p1).toBeUndefined();
  });
});

/**
 * The sidebar's viewing preferences: how it groups what it draws, how it orders
 * the rows, and the manual arrangement a drag leaves behind. All three are
 * cached in `localStorage`, so these stand one up and read it back.
 */
describe("sidebar view preferences", () => {
  const entries = new Map<string, string>();
  const KEY = "pi-web-simple.sidebar-view.v1";
  const stored = (): Record<string, unknown> =>
    JSON.parse(entries.get(KEY) ?? "{}") as Record<string, unknown>;

  const project = (id: string, order: number): ProjectView => ({
    id,
    path: `/home/me/${id}`,
    title: id,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  });

  beforeEach(() => {
    resetAppState();
    entries.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string): string | null => entries.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        entries.set(key, value);
      },
      removeItem: (key: string): void => {
        entries.delete(key);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The file's own stub; `unstubAllGlobals` takes it down with the rest.
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("saves the grouping and the order as they are picked", () => {
    actions.setGroupBy("flat");
    expect(appStore.get().sidebarView.groupBy).toBe("flat");
    expect(stored().groupBy).toBe("flat");

    actions.setOrderBy("manual");
    expect(appStore.get().sidebarView.orderBy).toBe("manual");
    expect(stored().orderBy).toBe("manual");
  });

  it("saves one account's manual order under its key", () => {
    actions.setSessionOrder("p1", ["b", "a"]);
    actions.setSessionOrder("p2", ["c"]);
    expect(appStore.get().sidebarView.sessionOrder).toEqual({ p1: ["b", "a"], p2: ["c"] });
    expect(stored().sessionOrder).toEqual({ p1: ["b", "a"], p2: ["c"] });
  });

  it("permutes the order a drop reports and saves the result", () => {
    actions.moveSession("p1", ["a", "b", "c"], "c", "a", "before");
    expect(appStore.get().sidebarView.sessionOrder.p1).toEqual(["c", "a", "b"]);
  });

  it("writes nothing for a drop that changes nothing", () => {
    actions.moveSession("p1", ["a", "b", "c"], "b", "c", "before");
    expect(appStore.get().sidebarView.sessionOrder).toEqual({});
    expect(entries.has(KEY)).toBe(false);
  });

  it("sends a workspace drop to the server, in the order the tree draws", async () => {
    appStore.update((state) => ({ ...state, projects: [project("a", 0), project("b", 1)] }));
    mocked.reorderProjects.mockResolvedValue([project("b", 0), project("a", 1)]);

    await actions.moveProject("a", undefined);

    expect(mocked.reorderProjects).toHaveBeenCalledWith(["b", "a"]);
    expect(appStore.get().projects.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("surfaces a rejected workspace reorder instead of reordering anyway", async () => {
    appStore.update((state) => ({ ...state, projects: [project("a", 0), project("b", 1)] }));
    mocked.reorderProjects.mockRejectedValue(new Error("reorder must list every project once"));

    await actions.moveProject("b", "a");

    expect(appStore.get().notice).toBe("reorder must list every project once");
    expect(appStore.get().projects.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("widens every workspace when the one list is picked", async () => {
    // The flat view has no workspace rows, and so no "show more" to reveal the
    // rest from: it has to hold the whole history already.
    appStore.update((state) => ({ ...state, projects: [project("a", 0), project("b", 1)] }));
    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 1 });

    actions.setGroupBy("flat");
    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledTimes(2);
    });
    expect(mocked.listSessions.mock.calls.map((call) => call[1]?.limit)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

/**
 * The sidebar's run-state mark comes from agent boundaries, not from the
 * conversation view — it has to keep working for a session the user is not
 * currently looking at.
 */
describe("session activity marks", () => {
  const PATH = "/sessions/proj-abc/live.jsonl";

  it("marks a session ongoing when its agent starts", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });

    expect(appStore.get().sessionActivity[PATH]).toBe("ongoing");
  });

  it("turns that into a completion reminder once it settles elsewhere", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(appStore.get().sessionActivity[PATH]).toBe("done");
  });

  it("never reminds the user about the session they are watching", () => {
    actions.selectSession(PATH);
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(appStore.get().sessionActivity[PATH]).toBeUndefined();
  });

  it("clears the reminder when the session is opened", () => {
    actions.emitSessionEvent(PATH, { type: "agent_settled" });
    expect(appStore.get().sessionActivity[PATH]).toBe("done");

    actions.selectSession(PATH);

    expect(appStore.get().sessionActivity[PATH]).toBeUndefined();
  });

  it("keeps a running mark when the session is opened", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });

    actions.selectSession(PATH);

    expect(appStore.get().sessionActivity[PATH]).toBe("ongoing");
  });

  it("ignores the token deltas between the boundaries", () => {
    actions.emitSessionEvent(PATH, { type: "message_update", delta: "x" });

    expect(appStore.get().sessionActivity[PATH]).toBeUndefined();
  });

  it("retires a running mark whose process a fresh hello no longer lists", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });

    // The stream was down when the process died (a server restart), so no
    // `session_closed` arrives; the reconnect's handle list is the news.
    actions.reconcileActiveSessions([]);

    expect(appStore.get().sessionActivity[PATH]).toBeUndefined();
  });

  it("keeps a running mark while its process is still live", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });

    actions.reconcileActiveSessions([PATH]);

    expect(appStore.get().sessionActivity[PATH]).toBe("ongoing");
    expect(appStore.get().activeSessions).toEqual([PATH]);
  });

  it("leaves a completion reminder alone when its process is gone", () => {
    // "done" is a reminder the user clears by opening the session, not a claim
    // about a live process, so the handle list does not speak to it.
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    actions.reconcileActiveSessions([]);

    expect(appStore.get().sessionActivity[PATH]).toBe("done");
  });
});

/**
 * The browser-notification half of the sidebar's run-state mark: the same
 * boundaries, surfaced outside the tab for a user who has walked away from it.
 */
describe("task-finished notifications", () => {
  const PATH = "/home/me/.pi/agent/sessions/proj-abc/notify.jsonl";

  /** The settings write stub, standing in for a successful `PUT /api/settings`. */
  function setEnabled(enabled: boolean): void {
    appStore.update((state) => ({
      ...state,
      settings: { ...state.settings, browserNotifications: enabled },
    }));
  }

  function sessionView(path: string, title: string): SessionView {
    return {
      path,
      id: "s1",
      cwd: "/home/me/proj",
      title,
      titleSource: "session",
      preview: "",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      hidden: false,
    };
  }

  beforeEach(() => {
    shownNotifications.length = 0;
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
  });

  afterEach(() => {
    // `unstubAllGlobals` also removes the file-level `navigator` stub the copy
    // assertions depend on, so it is put back here rather than left to leak
    // English into every later describe.
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("stays silent while the preference is off", () => {
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(0);
  });

  it("announces a task that finishes out of view", () => {
    setEnabled(true);
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(1);
    // The app's name is the title, because that is the one line of the notice
    // this page owns — the platform puts the origin above it.
    expect(shownNotifications[0]?.title).toBe(APP_NAME);
    expect(shownNotifications[0]?.options?.body).toBe("会话任务已完成");
    // One slot per session, so a second finish replaces the first instead of
    // stacking a duplicate of the same news.
    expect(shownNotifications[0]?.options?.tag).toBe(PATH);
  });

  it("names the session in the body", () => {
    setEnabled(true);
    appStore.update((state) => ({
      ...state,
      sessions: { "proj-abc": [sessionView(PATH, "修复登录问题")] },
    }));
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications[0]?.title).toBe(APP_NAME);
    expect(shownNotifications[0]?.options?.body).toBe("修复登录问题 · 会话任务已完成");
  });

  it("falls back to the bare sentence when the list does not know the session", () => {
    setEnabled(true);
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications[0]?.title).toBe(APP_NAME);
    expect(shownNotifications[0]?.options?.body).toBe("会话任务已完成");
  });

  it("does not announce a task the user is watching", () => {
    setEnabled(true);
    actions.selectSession(PATH);
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(0);
  });

  it("announces a task in the session the user selected and then walked away from", () => {
    setEnabled(true);
    actions.selectSession(PATH);
    // The session stays open in the reading pane; the tab is merely not the one
    // on screen. That is the finish the notice exists for.
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(1);
    // No dot is left behind on the session they have open: the mark answers
    // "which session do I still have to open", and this one already is.
    expect(appStore.get().sessionActivity[PATH]).toBeUndefined();
  });

  it("announces a finish it never saw start", () => {
    setEnabled(true);
    // A reload mid-run, or a task run from somewhere else: the settle frame is
    // live news either way, so this tab has a finish to report.
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(1);
  });

  it("stays silent when the browser has denied permission", () => {
    setEnabled(true);
    FakeNotification.permission = "denied";
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shownNotifications).toHaveLength(0);
  });

  it("opens the finished session when the notice is clicked", () => {
    setEnabled(true);
    actions.emitSessionEvent(PATH, { type: "agent_start" });
    actions.emitSessionEvent(PATH, { type: "agent_settled" });

    shownNotifications[0]?.onclick?.();

    expect(appStore.get().selectedSessionPath).toBe(PATH);
  });
});

/**
 * The desktop shell's half: a click on a shell notice opens the session it
 * named, and the count of finished-but-unopened sessions rides on the shell's
 * icon.
 *
 * The module is re-imported per test because both wirings happen once, at load
 * time — the click listener while the module is evaluated, the badge
 * subscription right after it.
 */
describe("desktop notifications", () => {
  const PATH = "/home/me/.pi/agent/sessions/proj-abc/notify.jsonl";
  const clickListeners: ((sessionPath: string) => void)[] = [];

  /** Import app-state behind a shell bridge, capturing its click listener. */
  async function freshApp() {
    vi.resetModules();
    const shell = {
      notify: vi.fn(),
      setBadge: vi.fn(),
      onNotificationClick: vi.fn((listener: (sessionPath: string) => void) => {
        clickListeners.push(listener);
        return () => {};
      }),
    };
    vi.stubGlobal("window", {
      piWebDesktop: {
        isDesktop: true,
        platform: "darwin",
        electronVersion: "44.0.0",
        ...shell,
      },
    });
    return { app: await import("./app-state.ts"), shell };
  }

  beforeEach(() => {
    clickListeners.length = 0;
  });

  afterEach(() => {
    // Put the host locale back: `unstubAllGlobals` also removes the file-level
    // `navigator` stub the copy assertions depend on.
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("counts a finished session the user has not opened, and clears it on open", async () => {
    const { app, shell } = await freshApp();

    app.actions.emitSessionEvent(PATH, { type: "agent_start" });
    app.actions.emitSessionEvent(PATH, { type: "agent_settled" });

    expect(shell.setBadge).toHaveBeenLastCalledWith(1);

    app.actions.selectSession(PATH);
    expect(shell.setBadge).toHaveBeenLastCalledWith(0);
  });

  it("opens the session the shell notice named", async () => {
    const { app } = await freshApp();

    clickListeners[0]?.(PATH);

    expect(app.appStore.get().selectedSessionPath).toBe(PATH);
  });
});

describe("deleting a session", () => {
  it("clears the selection and says where the file went", async () => {
    mocked.deleteSession.mockResolvedValue({ ok: true, method: "trash" });
    actions.selectSession(REAL_PATH);
    actions.markExternalChanged(REAL_PATH);

    await actions.deleteSession(REAL_PATH);

    expect(mocked.deleteSession).toHaveBeenCalledWith(REAL_PATH);
    expect(appStore.get().selectedSessionPath).toBeNull();
    expect(appStore.get().externalChanged[REAL_PATH]).toBeUndefined();
    expect(appStore.get().notice).toBe("已将会话移到废纸篓。");
  });

  it("distinguishes a permanent delete from a trashed one", async () => {
    mocked.deleteSession.mockResolvedValue({ ok: true, method: "unlink" });

    await actions.deleteSession("/other.jsonl");

    expect(appStore.get().notice).toBe("已永久删除会话。");
  });

  it("keeps the open conversation and reports the failure when the delete fails", async () => {
    mocked.deleteSession.mockRejectedValue(new Error("无法删除会话：EPERM"));
    actions.selectSession(REAL_PATH);

    await actions.deleteSession(REAL_PATH);

    expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    expect(appStore.get().notice).toBe("无法删除会话：EPERM");
  });
});

describe("new session hero", () => {
  it("clears the open conversation", () => {
    actions.selectSession("/some/session.jsonl");
    actions.enterNewSession();
    expect(appStore.get().selectedSessionPath).toBeNull();
  });

  it("creates a draft and queues the first message", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1", "build me a thing");

    // The UI switches to the draft before pi has even been asked for a session.
    expect(isDraftSession(appStore.get().selectedSessionPath)).toBe(true);
    // No model chosen means "start on pi's default", which is not the same
    // request as naming the model pi would have picked anyway.
    expect(mocked.createSession).toHaveBeenCalledWith("project-1", null, null, null);

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await vi.waitFor(() => {
      expect(appStore.get().pendingPrompt?.text).toBe("build me a thing");
    });
    expect(appStore.get().pendingPrompt?.sessionPath).toBe(REAL_PATH);
    expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
  });

  it("does not queue an empty first message", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1", "   ");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(appStore.get().pendingPrompt).toBeNull();
  });

  it("hands the picked model to the session being created, once", async () => {
    const create = deferredCreate();
    const picked = { provider: "cz", id: "glm", name: "GLM 5.3", contextWindow: 64000, reasoning: true, thinkingLevels: ["off", "low", "high"] };
    actions.setNewSessionModel(picked);

    // The hero reads the choice off the store and passes it along, which is
    // what this mirrors.
    actions.startDraftSession("project-1", "hello", [], appStore.get().newSessionModel);

    expect(mocked.createSession).toHaveBeenCalledWith("project-1", picked, null, null);
    // Consumed by the session it was chosen for: the next new session starts
    // from pi's default again.
    expect(appStore.get().newSessionModel).toBeNull();

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });
    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
  });

  it("reports a model the session could not be started on, and keeps the session", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1", "hello");
    create.resolve({
      sessionPath: REAL_PATH,
      sessionId: "s1",
      projectPath: "/home/me/proj",
      prewarmed: false,
      presetId: "standard",
      modelError: "无法切换到 cz/gone：Model not found",
    });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(appStore.get().notice).toBe("无法切换到 cz/gone：Model not found");
  });

  it("hands the picked thinking level to the session being created, once", async () => {
    const create = deferredCreate();
    actions.setNewSessionThinkingLevel("high");

    actions.startDraftSession(
      "project-1",
      "hello",
      [],
      null,
      appStore.get().newSessionThinkingLevel,
    );

    expect(mocked.createSession).toHaveBeenCalledWith("project-1", null, "high", null);
    // Consumed by the session it was chosen for, exactly like the model.
    expect(appStore.get().newSessionThinkingLevel).toBeNull();

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "standard" });
    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
  });

  it("reports a thinking level the session could not start on, and keeps the session", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1", "hello");
    create.resolve({
      sessionPath: REAL_PATH,
      sessionId: "s1",
      projectPath: "/home/me/proj",
      prewarmed: false,
      presetId: "standard",
      thinkingError: "无法设置思考强度为 impossible：invalid level",
    });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(appStore.get().notice).toBe("无法设置思考强度为 impossible：invalid level");
  });

  it("hands the picked composition to the session being created, once", async () => {
    const create = deferredCreate();
    actions.setNewSessionPresetId("minimal");

    actions.startDraftSession(
      "project-1",
      "hello",
      [],
      null,
      null,
      appStore.get().newSessionPresetId,
    );

    expect(mocked.createSession).toHaveBeenCalledWith("project-1", null, null, "minimal");
    // Consumed like the model, for a stronger reason: a preset is the arguments
    // pi is started with, so it can never be applied to a session that already
    // exists — the next creation is the only thing it can mean.
    expect(appStore.get().newSessionPresetId).toBeNull();

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false, presetId: "minimal" });
    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
  });

  it("drops the picked model when the user leaves the new-session flow", () => {
    actions.setNewSessionModel({ provider: "cz", id: "glm", name: null, contextWindow: 0, reasoning: false, thinkingLevels: ["off"] });
    actions.selectSession(REAL_PATH);
    expect(appStore.get().newSessionModel).toBeNull();
  });

  it("drops the picked thinking level when the user opens another session", () => {
    actions.setNewSessionThinkingLevel("max");
    actions.selectSession(REAL_PATH);
    expect(appStore.get().newSessionThinkingLevel).toBeNull();
  });
});

describe("session list refresh on first assistant output", () => {
  it("refreshes only the selected project", async () => {
    const project: ProjectView = {
      id: "project-1",
      path: "/home/me/proj",
      title: "proj",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      exists: true,
    };
    mocked.listProjects.mockResolvedValue([project]);
    mocked.listSessions.mockResolvedValue({ sessions: [], total: 0 });

    await actions.bootstrap();
    mocked.listSessions.mockClear();

    actions.refreshSelectedProjectSessions();
    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledWith("project-1", { limit: 5, focus: null });
    });
  });

  it("does nothing when no project is selected", () => {
    mocked.listSessions.mockClear();
    actions.refreshSelectedProjectSessions();
    expect(mocked.listSessions).not.toHaveBeenCalled();
  });
});

/**
 * The sidebar fetches one page rather than the workspace's whole history: it
 * holds the rows the server sent plus a count, and asks for more only when it
 * has to.
 */
describe("session list pagination", () => {
  const project: ProjectView = {
    id: "project-1",
    path: "/home/me/proj",
    title: "proj",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  };

  beforeEach(() => {
    mocked.listProjects.mockResolvedValue([project]);
  });

  it("skips a fetch when the page it would ask for is already held", async () => {
    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 1 });
    await actions.bootstrap();
    mocked.listSessions.mockClear();

    await actions.refreshSessions("project-1");
    expect(mocked.listSessions).not.toHaveBeenCalled();

    // A forced refresh — `sessions_changed`, a reconnect, a hide — still goes out.
    await actions.refreshSessions("project-1", { force: true });
    expect(mocked.listSessions).toHaveBeenCalledTimes(1);
  });

  it("asks for the next page when the workspace reveals more", async () => {
    mocked.listSessions.mockResolvedValue({ sessions: [], total: 12 });
    await actions.bootstrap();
    mocked.listSessions.mockClear();

    actions.revealMoreSessions("project-1", 10);
    expect(appStore.get().revealedSessions["project-1"]).toBe(10);
    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledWith("project-1", { limit: 10, focus: null });
    });
  });

  it("keeps the total the server reported with the page", async () => {
    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 12 });
    await actions.bootstrap();

    expect(appStore.get().sessionTotals["project-1"]).toBe(12);
    expect(appStore.get().sessions["project-1"]).toHaveLength(1);
  });

  it("widens a loaded workspace to the whole list when a search starts", async () => {
    mocked.listSessions.mockResolvedValue({ sessions: [diskSession(REAL_PATH)], total: 12 });
    await actions.bootstrap();
    mocked.listSessions.mockClear();

    // A search screens titles on the client, so it cannot work from one page.
    actions.setSessionQuery("one");
    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledTimes(1);
    });
    const call = mocked.listSessions.mock.calls.at(-1);
    expect(call?.[0]).toBe("project-1");
    expect(call?.[1]?.limit).toBeUndefined();

    // Keystrokes after the first one do not ask again.
    mocked.listSessions.mockResolvedValue({
      sessions: [diskSession(REAL_PATH)],
      total: 1,
    });
    actions.setSessionQuery("one two");
    expect(mocked.listSessions).toHaveBeenCalledTimes(1);
  });
});
