import { describe, expect, it } from "vitest";
import { wantsFrame, type BusEvent } from "./bus.ts";

/** A `session_event` wrapper around one bare session frame. */
function streamed(sessionPath: string, type: string): BusEvent {
  return {
    type: "session_event",
    sessionPath,
    event: { type },
  } as unknown as BusEvent;
}

describe("wantsFrame", () => {
  it("sends everything until the client declares a session", () => {
    // An undeclared connection may be an older client, or one whose first
    // subscription has not landed; either way its first frames must not vanish.
    expect(wantsFrame(undefined, streamed("/a", "message_update"))).toBe(true);
    expect(wantsFrame(undefined, { type: "sessions_changed", projectPath: "/p" })).toBe(true);
  });

  it("keeps the streaming frames of the session being read", () => {
    expect(wantsFrame("/a", streamed("/a", "message_update"))).toBe(true);
    expect(wantsFrame("/a", streamed("/a", "tool_execution_update"))).toBe(true);
  });

  it("drops another session's streaming frames", () => {
    expect(wantsFrame("/a", streamed("/b", "message_update"))).toBe(false);
    expect(wantsFrame("/a", streamed("/b", "tool_execution_update"))).toBe(false);
  });

  it("keeps another session's low-volume frames", () => {
    // The sidebar's status dots, and a dialog blocking some *other* session,
    // both depend on these arriving for tabs that are not reading that session.
    expect(wantsFrame("/a", streamed("/b", "agent_start"))).toBe(true);
    expect(wantsFrame("/a", streamed("/b", "agent_settled"))).toBe(true);
    expect(wantsFrame("/a", streamed("/b", "extension_ui_request"))).toBe(true);
  });

  it("keeps only the shared frames when reading no session", () => {
    expect(wantsFrame(null, { type: "projects_changed" })).toBe(true);
    expect(wantsFrame(null, streamed("/b", "agent_start"))).toBe(true);
    expect(wantsFrame(null, streamed("/b", "message_update"))).toBe(false);
  });
});
