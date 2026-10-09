import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These assertions name the copy, so fix the host locale for the file.
vi.stubGlobal("navigator", { language: "zh-CN" });
import { appStore, resetAppState, type AppState } from "../../lib/app-state.ts";
import type { ProjectView, SessionView } from "../../lib/types.ts";
import { FlatSessionList } from "./FlatSessionList.tsx";
import { NO_DRAG } from "./use-sidebar-drag.ts";

function project(id: string, order: number): ProjectView {
  return {
    id,
    path: `/Users/dev/${id}`,
    title: id,
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

function seed(overrides: Partial<AppState> = {}): void {
  appStore.set({
    ...appStore.get(),
    projects: [project("p1", 0), project("p2", 1)],
    sessions: {
      p1: [session("/s/a.jsonl", "alpha", "2026-01-04T00:00:00.000Z")],
      p2: [session("/s/b.jsonl", "beta", "2026-01-09T00:00:00.000Z")],
    },
    sessionTotals: { p1: 1, p2: 1 },
    unsavedSessions: {},
    sessionQuery: "",
    ...overrides,
  });
}

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("navigator", { language: "zh-CN" });
});

describe("FlatSessionList", () => {
  it("draws every workspace's sessions in one column, newest first", () => {
    seed();
    const html = renderToStaticMarkup(<FlatSessionList drag={NO_DRAG} />);

    expect(html).toContain("beta");
    expect(html).toContain("alpha");
    // beta is newer, so it leads — the two pages are merged and re-sorted.
    expect(html.indexOf("beta")).toBeLessThan(html.indexOf("alpha"));
  });

  it("has no workspace headers to draw", () => {
    seed();
    const html = renderToStaticMarkup(<FlatSessionList drag={NO_DRAG} />);
    expect(html).not.toContain("data-workspace-row");
  });

  it("shows the empty state when there is nothing at all", () => {
    seed({ sessions: {}, sessionTotals: {} });
    const html = renderToStaticMarkup(<FlatSessionList drag={NO_DRAG} />);
    expect(html).toContain("还没有会话");
  });

  it("keeps the search filter", () => {
    seed({ sessionQuery: "beta" });
    const html = renderToStaticMarkup(<FlatSessionList drag={NO_DRAG} />);
    expect(html).toContain("beta");
    expect(html).not.toContain("alpha");
  });
});
