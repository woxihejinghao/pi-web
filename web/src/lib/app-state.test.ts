import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Interface copy resolves through `useT`, and the default `system` preference
// lands on English without a navigator (node test environment). The assertions
// below pin the Chinese wording, so fix the host locale here.
vi.stubGlobal("navigator", { language: "zh-CN" });
import { api } from "./api.ts";
import {
  actions,
  appStore,
  isDraftSession,
  resetAppState,
  DRAFT_PREFIX,
} from "./app-state.ts";
import type { ExtensionUiRequest, ProjectView, SessionView } from "./types.ts";

vi.mock("./api.ts", () => ({
  api: {
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  resetAppState();
  mocked.listProjects.mockResolvedValue([]);
  mocked.listSessions.mockResolvedValue([]);
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

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(isDraftSession(appStore.get().selectedSessionPath)).toBe(false);
  });

  it("remembers which workspace owns the draft", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    expect(appStore.get().draftProjectId).toBe("project-1");

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    // Still project-1 after the swap: the real path stays provisional until
    // the session list catches up with it, and `selectProject` does not clear
    // the selection, so this is what keeps a neighbour's workspace from
    // claiming the row.
    expect(appStore.get().draftProjectId).toBe("project-1");
  });

  it("does not steal selection back if the user moved on", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");

    // The user navigates to another conversation while the spawn is in flight.
    actions.selectSession("/home/me/.pi/agent/sessions/proj-abc/other.jsonl");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

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
    expect(appStore.get().notice).toBe("pi rpc failed: boom");
  });

  it("resolveDraftSession returns the real path", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

    await expect(actions.resolveDraftSession()).resolves.toBe(REAL_PATH);
  });

  it("resolveDraftSession is null when nothing was started", async () => {
    await expect(actions.resolveDraftSession()).resolves.toBeNull();
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
    expect(appStore.get().commands["project-1"]).toEqual(commands);

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
    expect(appStore.get().commands["project-1"]).toBeUndefined();

    await actions.loadCommands("project-1");
    expect(mocked.listCommands).toHaveBeenCalledTimes(2);
  });

  it("keeps per-project results separate", async () => {
    mocked.listCommands.mockResolvedValueOnce({ commands });
    mocked.listCommands.mockResolvedValueOnce({ commands: [] });

    await actions.loadCommands("project-1");
    await actions.loadCommands("project-2");

    expect(appStore.get().commands["project-1"]).toEqual(commands);
    expect(appStore.get().commands["project-2"]).toEqual([]);
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

  it("clears the search query when the field is closed", () => {
    actions.setSessionQuery("abc");
    actions.toggleSearch(); // opens
    expect(appStore.get().searchOpen).toBe(true);
    actions.toggleSearch(); // closes and clears
    expect(appStore.get().searchOpen).toBe(false);
    expect(appStore.get().sessionQuery).toBe("");
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
    expect(mocked.createSession).toHaveBeenCalledWith("project-1", null);

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

    await vi.waitFor(() => {
      expect(appStore.get().pendingPrompt?.text).toBe("build me a thing");
    });
    expect(appStore.get().pendingPrompt?.sessionPath).toBe(REAL_PATH);
    expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
  });

  it("does not queue an empty first message", async () => {
    const create = deferredCreate();
    actions.startDraftSession("project-1", "   ");
    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(appStore.get().pendingPrompt).toBeNull();
  });

  it("hands the picked model to the session being created, once", async () => {
    const create = deferredCreate();
    const picked = { provider: "cz", id: "glm", name: "GLM 5.3", contextWindow: 64000, reasoning: true };
    actions.setNewSessionModel(picked);

    // The hero reads the choice off the store and passes it along, which is
    // what this mirrors.
    actions.startDraftSession("project-1", "hello", [], appStore.get().newSessionModel);

    expect(mocked.createSession).toHaveBeenCalledWith("project-1", picked);
    // Consumed by the session it was chosen for: the next new session starts
    // from pi's default again.
    expect(appStore.get().newSessionModel).toBeNull();

    create.resolve({ sessionPath: REAL_PATH, sessionId: "s1", projectPath: "/home/me/proj", prewarmed: false });
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
      modelError: "无法切换到 cz/gone：Model not found",
    });

    await vi.waitFor(() => {
      expect(appStore.get().selectedSessionPath).toBe(REAL_PATH);
    });
    expect(appStore.get().notice).toBe("无法切换到 cz/gone：Model not found");
  });

  it("drops the picked model when the user leaves the new-session flow", () => {
    actions.setNewSessionModel({ provider: "cz", id: "glm", name: null, contextWindow: 0, reasoning: false });
    actions.selectSession(REAL_PATH);
    expect(appStore.get().newSessionModel).toBeNull();
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
    mocked.listSessions.mockResolvedValue([] as SessionView[]);

    await actions.bootstrap();
    mocked.listSessions.mockClear();

    actions.refreshSelectedProjectSessions();
    await vi.waitFor(() => {
      expect(mocked.listSessions).toHaveBeenCalledWith("project-1", true);
    });
  });

  it("does nothing when no project is selected", () => {
    mocked.listSessions.mockClear();
    actions.refreshSelectedProjectSessions();
    expect(mocked.listSessions).not.toHaveBeenCalled();
  });
});
