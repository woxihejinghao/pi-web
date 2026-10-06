import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { actions, resetAppState } from "../../lib/app-state.ts";
import { useConversation } from "./useConversation.ts";

const RUNNING = "/home/me/.pi/agent/sessions/proj-abc/running.jsonl";
const OTHER = "/home/me/.pi/agent/sessions/proj-abc/other.jsonl";

/**
 * A static probe for the public run-state of the hook.
 *
 * Effects do not run in a static render, so the transcript load and the event
 * subscription never happen — which is exactly the point: this asserts what the
 * hook reports from app state alone, on the first render of a session that was
 * started somewhere else.
 */
function Probe({ sessionPath }: { sessionPath: string | null }) {
  const { isStreaming } = useConversation(sessionPath);
  return <span>{isStreaming ? "working" : "idle"}</span>;
}

beforeEach(() => {
  resetAppState();
});

describe("useConversation run state", () => {
  it("reports a session running in the background as working when reopened", () => {
    actions.markSessionOngoing(RUNNING);

    expect(renderToStaticMarkup(<Probe sessionPath={RUNNING} />)).toContain("working");
  });

  it("stays idle for a session that is not running", () => {
    actions.markSessionOngoing(RUNNING);

    expect(renderToStaticMarkup(<Probe sessionPath={OTHER} />)).toContain("idle");
    expect(renderToStaticMarkup(<Probe sessionPath={null} />)).toContain("idle");
  });

  it("goes idle once the run settles", () => {
    actions.markSessionOngoing(RUNNING);
    actions.markSessionSettled(RUNNING);

    expect(renderToStaticMarkup(<Probe sessionPath={RUNNING} />)).toContain("idle");
  });

  it("does not treat a completion reminder as still working", () => {
    // Settled while the user was elsewhere: the mark is a "done" reminder, not
    // a live run.
    actions.markSessionSettled(RUNNING);

    expect(renderToStaticMarkup(<Probe sessionPath={RUNNING} />)).toContain("idle");
  });
});
