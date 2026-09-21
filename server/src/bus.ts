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

export const bus = new EventBus();
export { EventBus };
