import { actions, appStore } from "./app-state.ts";
import type { BusEvent, ExtensionUiRequest } from "./types.ts";

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
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    void actions.refreshProjects();
    const selected = appStore.get().selectedProjectId;
    if (selected) void actions.refreshSessions(selected);
  });

  source.addEventListener("hello", (raw) => {
    const data = parse<{ activeSessions: string[] }>(raw);
    if (data) actions.setActiveSessions(data.activeSessions);
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
        actions.setPendingUiRequest({ sessionPath: data.sessionPath, request });
      }
    }
  });

  source.addEventListener("session_closed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "session_closed" }>>(raw);
    if (!data) return;
    actions.setActiveSessions(appStore.get().activeSessions.filter((p) => p !== data.sessionPath));
  });

  source.addEventListener("session_external_changed", (raw) => {
    const data = parse<Extract<BusEvent, { type: "session_external_changed" }>>(raw);
    if (data) actions.markExternalChanged(data.sessionPath);
  });

  return () => source.close();
}
