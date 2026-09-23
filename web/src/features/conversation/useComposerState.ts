import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { actions, appStore, sessionEvents } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import type { ComposerState } from "../../lib/types.ts";

/**
 * Where the composer's figures come from.
 *
 * A session and a project are two cases rather than a pair to fall back
 * through: a session answers for itself (its file first, a live process only
 * when asked), while a project answers for the session that does not exist yet
 * — the new-session page, where the first message has not created one.
 */
export interface ComposerSource {
  /** The open session; null on the new-session path. */
  sessionPath: string | null;
  /** The project whose defaults describe a not-yet-created session. */
  projectId: string | null;
}

export interface ComposerApi {
  /** null until the first read lands. Cheap: it comes from the session file. */
  state: ComposerState | null;
  /** True while a deliberate spawn is in flight, i.e. the model list is coming. */
  modelsLoading: boolean;
  /**
   * Ask for a live answer.
   *
   * The switchable model list and a fresh context estimate only exist inside a
   * running pi, so opening the model menu pays one cold start here — at the
   * moment the user asked for it — instead of on every sidebar click.
   */
  ensureLive(): Promise<void>;
  /** Switch the session's model. Resolves once the server confirmed it. */
  selectModel(provider: string, id: string): Promise<void>;
}

/**
 * The composer's model and context figures for one session — or, before that
 * session exists, for the project it will be created in.
 *
 * Reads are split by cost on purpose. The first read comes from the session
 * file, because the session is usually not resident and spawning pi to fill in
 * an input bar would undo the disk-read path that makes switching sessions
 * fast. A live read happens when the user opens the model menu (the list of
 * models cannot be known otherwise) and once per settled turn, when the process
 * is necessarily running and the context figure has just changed.
 *
 * The project path needs neither. pi's own resolver answers from `models.json`,
 * its built-in catalog and `auth.json` in about 15ms, so the new-session page
 * can offer exactly the list a running session would, without spawning one.
 */
export function useComposerState({ sessionPath, projectId }: ComposerSource): ComposerApi {
  const [state, setState] = useState<ComposerState | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  /**
   * The new-session page's own choice, which overrides the project default
   * until the session exists. Read from the app store rather than kept here
   * because the picker is the page's, and the choice has to outlive a re-render
   * of it.
   */
  const newSessionModel = useSyncExternalStore(
    appStore.subscribe,
    () => appStore.get().newSessionModel,
    () => appStore.get().newSessionModel,
  );
  /** What the current state belongs to: a session path, or `project:<id>`. */
  const sourceKey = sessionPath ?? (projectId === null ? null : `project:${projectId}`);
  /** Guards every async write: a reply for a source we left must be dropped. */
  const sourceRef = useRef<string | null>(sourceKey);
  const stateRef = useRef<ComposerState | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const apply = useCallback((key: string, next: ComposerState): void => {
    if (sourceRef.current !== key) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const loadSession = useCallback(
    async (path: string, spawn: boolean): Promise<void> => {
      try {
        apply(path, await api.getComposerState(path, { spawn }));
      } catch (err) {
        // A missing model name is not worth a dialog over the conversation;
        // the menu simply keeps offering what it had.
        actions.setNotice((err as Error).message);
      }
    },
    [apply],
  );

  const loadProject = useCallback(
    async (id: string): Promise<void> => {
      try {
        apply(`project:${id}`, await api.getProjectComposer(id));
      } catch (err) {
        actions.setNotice((err as Error).message);
      }
    },
    [apply],
  );

  useEffect(() => {
    sourceRef.current = sourceKey;
    stateRef.current = null;
    inflightRef.current = null;
    setState(null);
    setModelsLoading(false);
    if (sessionPath !== null) {
      void loadSession(sessionPath, false);
      return;
    }
    if (projectId !== null) {
      // This read also learns the model list, so the picker can say "loading"
      // rather than "unavailable" while it lands.
      setModelsLoading(true);
      void loadProject(projectId).finally(() => {
        if (sourceRef.current === `project:${projectId}`) setModelsLoading(false);
      });
    }
  }, [sessionPath, projectId, sourceKey, loadSession, loadProject]);

  // The context figure changes while the agent runs and settles at the end of a
  // turn. `agent_settled` is the moment it stops moving, and the one moment the
  // process is guaranteed to be resident — so this read is always live and never
  // costs a spawn.
  useEffect(() => {
    if (sessionPath === null) return;
    return sessionEvents.subscribe((payload) => {
      if (payload.sessionPath !== sessionPath) return;
      if (payload.event.type !== "agent_settled") return;
      void loadSession(sessionPath, false);
    });
  }, [sessionPath, loadSession]);

  const ensureLive = useCallback(async (): Promise<void> => {
    if (sessionPath === null) {
      // The project read has no live variant — it already answers from pi's own
      // resolver — so asking again means re-reading, for the case where the
      // first attempt failed or the model files changed since.
      const id = projectId;
      if (id === null || sourceRef.current !== `project:${id}`) return;
      const pending = inflightRef.current;
      if (pending !== null) return pending;
      setModelsLoading(true);
      const request = loadProject(id).finally(() => {
        if (sourceRef.current === `project:${id}`) setModelsLoading(false);
        inflightRef.current = null;
      });
      inflightRef.current = request;
      return request;
    }

    const path = sessionPath;
    if (stateRef.current?.live === true) return;
    const pending = inflightRef.current;
    if (pending !== null) return pending;

    setModelsLoading(true);
    const request = loadSession(path, true).finally(() => {
      if (sourceRef.current === path) setModelsLoading(false);
      inflightRef.current = null;
    });
    inflightRef.current = request;
    return request;
  }, [sessionPath, projectId, loadProject, loadSession]);

  const selectModel = useCallback(
    async (provider: string, id: string): Promise<void> => {
      const path = sessionPath;
      if (path === null) {
        // Nothing to switch yet: the choice is remembered instead, and
        // `createSession` applies it when the first message creates the session.
        const models = stateRef.current?.models ?? [];
        const chosen = models.find((entry) => entry.provider === provider && entry.id === id);
        actions.setNewSessionModel(chosen ?? null);
        return;
      }
      try {
        apply(path, await api.setSessionModel(path, provider, id));
      } catch (err) {
        actions.setNotice((err as Error).message);
      }
    },
    [sessionPath, apply],
  );

  /** The user's pick wins over pi's default until the session exists. */
  const overridden =
    sessionPath === null && state !== null && newSessionModel !== null
      ? { ...state, model: newSessionModel }
      : state;

  return { state: overridden, modelsLoading, ensureLive, selectModel };
}
