import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Everything the browser is told about, over one SSE stream. Session events
 * arrive at high frequency while a model streams, so the bus stays a plain
 * synchronous fan-out with no buffering.
 */
export type BusEvent =
  | { type: "session_event"; sessionPath: string; event: JsonAgentSessionEvent }
  | { type: "session_closed"; sessionPath: string; reason: string }
  | { type: "session_external_changed"; sessionPath: string; modifiedAt: string }
  | { type: "workspace_changed"; projectPath: string }
  | { type: "projects_changed" }
  | { type: "sessions_changed"; projectPath: string };

export type BusListener = (event: BusEvent) => void;

class EventBus {
  private readonly listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (usually a closed SSE socket) must not stop the
        // others from receiving the event.
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

/**
 * Session frames only the tab reading that session needs.
 *
 * These are the high-frequency incremental ones: one per token, plus pi's
 * tool-output deltas. They cannot be dropped or merged to save bandwidth —
 * `message_update` carries the delta rather than a snapshot, so losing one
 * corrupts the text. This filter never touches them for the session in view;
 * it only stops them from being fanned out to tabs reading something else.
 */
export const STREAM_ONLY_EVENTS: ReadonlySet<string> = new Set([
  "message_update",
  "tool_execution_update",
]);

/**
 * Whether a stream that is reading `sessionPath` needs this bus event.
 *
 * `undefined` means the client has not declared a session yet — it may be an
 * older client that never will — so it gets everything rather than silently
 * missing the frames of the session it is about to open. `null` means it is
 * reading no session: it still needs the low-volume frames every tab shares
 * (sidebar dots, blocked dialogs, project and session lists), just not any
 * session's token stream.
 */
export function wantsFrame(
  sessionPath: string | null | undefined,
  event: BusEvent,
): boolean {
  if (sessionPath === undefined) return true;
  if (event.type !== "session_event") return true;
  if (event.sessionPath === sessionPath) return true;
  return !STREAM_ONLY_EVENTS.has(event.event.type);
}

export const bus = new EventBus();
export { EventBus };
