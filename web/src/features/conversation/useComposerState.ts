import { useCallback, useEffect, useRef, useState } from "react";
import { actions, sessionEvents } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import type { ComposerState } from "../../lib/types.ts";

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
 * The composer's model and context figures for one session.
 *
 * Reads are split by cost on purpose. The first read comes from the session
 * file, because the session is usually not resident and spawning pi to fill in
 * an input bar would undo the disk-read path that makes switching sessions
 * fast. A live read happens when the user opens the model menu (the list of
 * models cannot be known otherwise) and once per settled turn, when the process
 * is necessarily running and the context figure has just changed.
 */
export function useComposerState(sessionPath: string | null): ComposerApi {
  const [state, setState] = useState<ComposerState | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  /** Guards every async write: a reply for a session we left must be dropped. */
  const pathRef = useRef<string | null>(sessionPath);
  const stateRef = useRef<ComposerState | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const apply = useCallback((path: string, next: ComposerState): void => {
    if (pathRef.current !== path) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const load = useCallback(
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

  useEffect(() => {
    pathRef.current = sessionPath;
    stateRef.current = null;
    inflightRef.current = null;
    setState(null);
    setModelsLoading(false);
    if (sessionPath === null) return;
    void load(sessionPath, false);
  }, [sessionPath, load]);

  // The context figure changes while the agent runs and settles at the end of a
  // turn. `agent_settled` is the moment it stops moving, and the one moment the
  // process is guaranteed to be resident — so this read is always live and never
  // costs a spawn.
  useEffect(() => {
    if (sessionPath === null) return;
    return sessionEvents.subscribe((payload) => {
      if (payload.sessionPath !== sessionPath) return;
      if (payload.event.type !== "agent_settled") return;
      void load(sessionPath, false);
    });
  }, [sessionPath, load]);

  const ensureLive = useCallback(async (): Promise<void> => {
    const path = sessionPath;
    if (path === null) return;
    if (stateRef.current?.live === true) return;
    if (inflightRef.current !== null) return inflightRef.current;

    setModelsLoading(true);
    const request = load(path, true).finally(() => {
      if (pathRef.current === path) setModelsLoading(false);
      inflightRef.current = null;
    });
    inflightRef.current = request;
    return request;
  }, [sessionPath, load]);

  const selectModel = useCallback(
    async (provider: string, id: string): Promise<void> => {
      const path = sessionPath;
      if (path === null) return;
      try {
        apply(path, await api.setSessionModel(path, provider, id));
      } catch (err) {
        actions.setNotice((err as Error).message);
      }
    },
    [sessionPath, apply],
  );

  return { state, modelsLoading, ensureLive, selectModel };
}
