import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, resetAppState, type AppState } from "../../lib/app-state.ts";
import { DEFAULT_SIDEBAR_VIEW, FLAT_ORDER_KEY } from "../../lib/sidebar-view.ts";
import type { ProjectView, SessionView } from "../../lib/types.ts";
import { flatSessionRowsOf, sessionRowsOf } from "./session-rows.ts";

function project(id: string, path: string, order: number): ProjectView {
  return {
    id,
    path,
    title: path.split("/").pop() ?? path,
    order,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exists: true,
  };
}

function session(path: string, title: string, modified: string, hidden = false): SessionView {
  return {
    path,
    id: path,
    cwd: "/Users/dev/proj",
    title,
    titleSource: "session",
    preview: "",
    created: modified,
    modified,
    messageCount: 1,
    hidden,
  };
}

/** The page the server answers with, newest first. */
const A = session("/s/a.jsonl", "alpha", "2026-01-04T00:00:00.000Z");
const B = session("/s/b.jsonl", "beta", "2026-01-03T00:00:00.000Z");
const C = session("/s/c.jsonl", "gamma", "2026-01-02T00:00:00.000Z");
const D = session("/s/d.jsonl", "delta", "2026-01-01T00:00:00.000Z");

function seed(overrides: Partial<AppState> = {}): void {
  appStore.set({
    ...appStore.get(),
    projects: [project("p1", "/Users/dev/proj", 0), project("p2", "/Users/dev/other", 1)],
    sessions: { p1: [A, B, C], p2: [D] },
    sessionTotals: { p1: 3, p2: 1 },
    selectedProjectId: "p1",
    sessionQuery: "",
    sidebarView: { ...DEFAULT_SIDEBAR_VIEW },
    unsavedSessions: {},
    revealedSessions: {},
    ...overrides,
  });
}

beforeEach(() => {
  resetAppState();
  // Locale-independent titles: these assertions name the rows, and the default
  // `system` language would otherwise decide how a draft is labelled.
  vi.stubGlobal("navigator", { language: "en-US" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionRowsOf", () => {
  it("draws the server's recency order by default", () => {
    seed();
    expect(sessionRowsOf(appStore.get(), "p1").sessions.map((s) => s.title))
      .toEqual(["alpha", "beta", "gamma"]);
  });

  it("drops hidden sessions", () => {
    seed({ sessions: { p1: [A, { ...B, hidden: true }], p2: [D] } });
    expect(sessionRowsOf(appStore.get(), "p1").sessions.map((s) => s.title)).toEqual(["alpha"]);
  });

  it("counts the folded rows from the server's total", () => {
    // Three of the nine are loaded, so six are still folded away.
    seed({ sessionTotals: { p1: 9, p2: 1 } });
    expect(sessionRowsOf(appStore.get(), "p1").remaining).toBe(6);
  });

  it("caps the page but not a search", () => {
    seed({ revealedSessions: { p1: 2 } });
    expect(sessionRowsOf(appStore.get(), "p1").sessions).toHaveLength(2);
    seed({ revealedSessions: { p1: 2 }, sessionQuery: "a" });
    const searched = sessionRowsOf(appStore.get(), "p1");
    expect(searched.sessions.map((s) => s.title)).toEqual(["alpha", "beta", "gamma"]);
    expect(searched.remaining).toBe(0);
  });

  it("keeps the saved manual order and trails the rows it has not seen", () => {
    seed({
      sidebarView: {
        ...DEFAULT_SIDEBAR_VIEW,
        orderBy: "manual",
        sessionOrder: { p1: ["/s/c.jsonl", "/s/a.jsonl"] },
      },
    });
    expect(sessionRowsOf(appStore.get(), "p1").sessions.map((s) => s.title))
      .toEqual(["gamma", "alpha", "beta"]);
  });

  it("skips a saved row that is no longer here", () => {
    seed({
      sidebarView: {
        ...DEFAULT_SIDEBAR_VIEW,
        orderBy: "manual",
        sessionOrder: { p1: ["/s/gone.jsonl", "/s/b.jsonl"] },
      },
    });
    expect(sessionRowsOf(appStore.get(), "p1").sessions.map((s) => s.title))
      .toEqual(["beta", "alpha", "gamma"]);
  });

  it("leads with the drafts that have no file yet", () => {
    seed({ unsavedSessions: { p1: ["draft:1", "/s/a.jsonl"] } });
    // The one whose file already landed is not drawn twice.
    expect(sessionRowsOf(appStore.get(), "p1").drafts).toEqual(["draft:1"]);
  });
});

describe("flatSessionRowsOf", () => {
  it("merges every workspace's rows by recency", () => {
    seed();
    expect(flatSessionRowsOf(appStore.get()).sessions.map((s) => s.title))
      .toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("orders the one list from its own account", () => {
    seed({
      sidebarView: {
        ...DEFAULT_SIDEBAR_VIEW,
        orderBy: "manual",
        sessionOrder: { [FLAT_ORDER_KEY]: ["/s/d.jsonl", "/s/b.jsonl"] },
      },
    });
    expect(flatSessionRowsOf(appStore.get()).sessions.map((s) => s.title))
      .toEqual(["delta", "beta", "alpha", "gamma"]);
  });

  it("follows the search and the hidden filter", () => {
    seed({ sessionQuery: "lph" });
    expect(flatSessionRowsOf(appStore.get()).sessions.map((s) => s.title))
      .toEqual(["alpha"]);
    seed({ sessions: { p1: [A, { ...B, hidden: true }, C], p2: [D] } });
    expect(flatSessionRowsOf(appStore.get()).sessions.map((s) => s.title))
      .toEqual(["alpha", "gamma", "delta"]);
  });

  it("collects the drafts of every workspace", () => {
    seed({ unsavedSessions: { p1: ["draft:1"], p2: ["draft:2"] } });
    expect(flatSessionRowsOf(appStore.get()).drafts).toEqual(["draft:1", "draft:2"]);
  });
});
