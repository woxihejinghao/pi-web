import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLastSession, readLastSession, writeLastSession } from "./last-session.ts";
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("last session record", () => {
  it("round-trips the workspace and the open session", () => {
    writeLastSession({ projectId: "p1", sessionPath: "/sessions/one.jsonl" });
    expect(readLastSession()).toEqual({ projectId: "p1", sessionPath: "/sessions/one.jsonl" });
  });
  it("round-trips the hero, where no session is open", () => {
    writeLastSession({ projectId: "p1", sessionPath: null });
    expect(readLastSession()).toEqual({ projectId: "p1", sessionPath: null });
  });
  it("reads nothing when the browser has no record", () => {
    expect(readLastSession()).toBeNull();
  });
  it("treats a half-written record as no record", () => {
    // A repaired guess would select a project that never existed and leave the
    // header blank; starting at the first workspace is the honest fallback.
    storage.set("pi-web-simple.last-session.v1", JSON.stringify({ sessionPath: "/one" }));
    expect(readLastSession()).toBeNull();
    storage.set("pi-web-simple.last-session.v1", JSON.stringify({ projectId: "p1", sessionPath: 1 }));
    expect(readLastSession()).toBeNull();
    storage.set("pi-web-simple.last-session.v1", "{not json");
    expect(readLastSession()).toBeNull();
  });
  it("forgets the record", () => {
    writeLastSession({ projectId: "p1", sessionPath: null });
    forgetLastSession();
    expect(readLastSession()).toBeNull();
  });
  it("survives a browser with storage disabled", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readLastSession()).toBeNull();
    expect(() => writeLastSession({ projectId: "p1", sessionPath: null })).not.toThrow();
    expect(() => forgetLastSession()).not.toThrow();
  });
});