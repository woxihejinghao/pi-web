import { actions, appStore, streamRestored, workspaceChanged } from "./app-state.ts";
import type { BusEvent, ExtensionUiRequest } from "./types.ts";

/**
 * The id the server handed this connection in `hello`; null before it arrives
 * and after the stream closes. It is how a subscription update names a stream.
 */
let connectionId: string | null = null;

/**
 * The session this tab is reading, kept across reconnects.
 *
 * `undefined` means the page has not decided yet. The server treats that (and
 * every connection before its first subscription) as "send everything", so a
 * late decision costs bandwidth, never frames.
 */
let wantedSession: string | null | undefined = undefined;

/** False until a connection opens, so a reconnect can be told from the first. */
let opened = false;

/**
 * Tell the server which session this tab is reading.
 *
 * Called on every session change from the shell. Fire-and-forget: until it
 * lands the server still sends every frame, so nothing is lost if it fails.
 */
export function setEventSession(sessionPath: string | null): void {
  wantedSession = sessionPath;
  void pushSubscription();
}

async function pushSubscription(): Promise<void> {
  if (connectionId === null || wantedSession === undefined) return;
  try {
    await fetch("/api/events/subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sessionPath: wantedSession }),
    });
  } catch {
    // A failed update only leaves the server fanning out everything. The next
    // session switch tries again.
  }
}

function parse<T>(raw: Event): T | null {
  const data = (raw as MessageEvent).data;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the server's SSE stream and folds it into app state.
 * `EventSource` reconnects on its own; `onopen` re-syncs after an outage.
 */
export function connectEvents(): () => void {
  // Each connection gets its own id and first-open state; the declared session
  // outlives a reconnect, so it is deliberately not reset here.
  connectionId = null;
  opened = false;
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    void actions.refreshProjects();
    const selected = appStore.get().selectedProjectId;
    if (selected) void actions.refreshSessions(selected);
    // The stream dropped and came back: frames were missed while it was away.
    // Tell whoever is reading to re-read instead of appending past the hole.
    if (opened) streamRestored.emit();
    opened = true;
  });

  source.addEventListener("hello", (raw) => {
    const data = parse<{ connectionId?: string; activeSessions: string[] }>(raw);
    if (!data) return;
    actions.setActiveSessions(data.activeSessions);
    connectionId = typeof data.connectionId === "string" ? data.connectionId : null;
    // A reconnect learns a fresh id, so the current session has to be declared
    // again for the new stream.
    void pushSubscription();
  });

  source.addEventListener("projects_changed", () => {
    void actions.refreshProjects();
  });

  source.addEventListener("sessions_changed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "sessions_changed" }>>(raw);
    const state = appStore.get();
    const projectId = data?.projectPath
      ? state.projects.find((project) => project.path === data.projectPath)?.id
      : state.selectedProjectId;
    if (projectId) void actions.refreshSessions(projectId);
  });

  source.addEventListener("session_event", (raw) => {
    const data = parse<Extract<BusEvent, { type: "session_event" }>>(raw);
    if (!data) return;
    actions.emitSessionEvent(data.sessionPath, data.event);

    // pi extensions can block on a dialog; surface it or the run stalls.
    if (data.event.type === "extension_ui_request") {
      const request = data.event as unknown as ExtensionUiRequest;
      if (request.method === "notify") {
        const text = typeof request.message === "string" ? request.message : "";
        if (text.length > 0) actions.setNotice(text);
      } else if (["confirm", "select", "input", "editor"].includes(request.method)) {
        actions.enqueueUiRequest({ sessionPath: data.sessionPath, request });
      }
    }
  });

  source.addEventListener("session_closed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "session_closed" }>>(raw);
    if (!data) return;
    actions.setActiveSessions(appStore.get().activeSessions.filter((p) => p !== data.sessionPath));
    // A process torn down mid-run never settles, so its running mark would
    // animate forever. The session going away clears it.
    actions.clearSessionActivity(data.sessionPath);
  });

  source.addEventListener("session_external_changed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "session_external_changed" }>>(raw);
    if (data) actions.markExternalChanged(data.sessionPath);
  });

  source.addEventListener("workspace_changed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "workspace_changed" }>>(raw);
    if (data) workspaceChanged.emit({ projectPath: data.projectPath });
  });

  return () => {
    source.close();
    connectionId = null;
  };
}
