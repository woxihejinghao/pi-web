import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { actions, appStore, isDraftSession, sessionEvents } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import type { ComposerState } from "../../lib/types.ts";
import { DEFAULT_PRESET_ID } from "../../lib/types.ts";

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
  /**
   * Switch the session's thinking level. Resolves once the server confirmed it,
   * and the state it resolves to is the level pi actually applied — an
   * unsupported one is clamped rather than refused.
   */
  selectThinking(level: string): Promise<void>;
  /**
   * Recompose a session that has not started talking.
   *
   * A preset decided the spawn arguments, so this is not a setting: the server
   * replaces the process, and only while the session has recorded no leading
   * system message. On the new-session path there is nothing to replace yet, so
   * the choice is remembered for `createSession` instead.
   */
  selectPreset(presetId: string): Promise<void>;
  /**
   * Record plan mode locally, before the session file can say so.
   *
   * pi writes a session file lazily — on the first real message — so a `/plan`
   * typed into a brand-new session leaves no trace on disk yet, and a read of
   * that file reports the mode as off. dsh's chip has the same job and reads a
   * host projection that folds the *pending* selection
   * (`pending ? !active : active`), so it shows the mode the command just asked
   * for; this is that idea with the browser as the only place left to hold it.
   * Every later read — a settled turn, a live read, a reload — replaces it with
   * the file's own answer.
   */
  markPlan(active: boolean): void;
  /**
   * Ask the running session what plan mode it holds.
   *
   * For the moment right after a `/plan` command: the mode reaches the process
   * first, and a session that has not spoken yet has no file to read it from.
   */
  syncPlan(): Promise<void>;
  /**
   * Switch plan mode for the open session.
   *
   * The switch itself runs an extension command inside pi (`POST
   * /api/sessions/:id/plan`), and the reply is the state the session file now
   * holds — so the badge follows the file rather than the click.
   */
  selectPlan(active: boolean): Promise<void>;
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
  /**
   * The hero's own thinking-level choice, for the same reason and read the same
   * way as `newSessionModel`.
   */
  const newSessionThinkingLevel = useSyncExternalStore(
    appStore.subscribe,
    () => appStore.get().newSessionThinkingLevel,
    () => appStore.get().newSessionThinkingLevel,
  );
  /** What the current state belongs to: a session path, or `project:<id>`. */
  const sourceKey = sessionPath ?? (projectId === null ? null : `project:${projectId}`);
  /** Guards every async write: a reply for a source we left must be dropped. */
  const sourceRef = useRef<string | null>(sourceKey);
  const stateRef = useRef<ComposerState | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  /** Context usage changes while a model is streaming. Keep reads single-flight and
   * coalesce token events so the composer stays live without creating one request
   * per token. */
  const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshRef = useRef<Promise<void> | null>(null);
  /**
   * A plan-mode switch this browser made that no authoritative read has confirmed.
   *
   * pi writes a session lazily, so while `sessionOnDisk` is false a read has
   * nothing to say about the mode and must not overwrite the switch; once the
   * file exists it is authoritative and this is dropped.
   */
  const planPendingRef = useRef<boolean | null>(null);

  const apply = useCallback((key: string, next: ComposerState): void => {
    if (sourceRef.current !== key) return;
    const pending = planPendingRef.current;
    // A read of a session that has no file yet cannot deny a switch made here
    // (pi writes the file on the first real message), so the local value stands
    // until something can contradict it. A session on disk is authoritative
    // either way, and the local value is dropped.
    const keep = pending !== null && next.sessionOnDisk !== true;
    if (!keep) planPendingRef.current = null;
    const merged = keep ? { ...next, planMode: pending } : next;
    stateRef.current = merged;
    setState(merged);
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

  const refreshLive = useCallback(
    async (path: string): Promise<void> => {
      if (sourceRef.current !== path) return;
      const pending = liveRefreshRef.current;
      if (pending !== null) return pending;
      const request = loadSession(path, false).finally(() => {
        if (liveRefreshRef.current === request) liveRefreshRef.current = null;
      });
      liveRefreshRef.current = request;
      return request;
    },
    [loadSession],
  );

  const scheduleLiveRefresh = useCallback(
    (path: string): void => {
      if (sourceRef.current !== path) return;
      if (liveRefreshTimerRef.current !== null) return;
      liveRefreshTimerRef.current = setTimeout(() => {
        liveRefreshTimerRef.current = null;
        void refreshLive(path);
      }, 250);
    },
    [refreshLive],
  );

  useEffect(() => {
    sourceRef.current = sourceKey;
    stateRef.current = null;
    inflightRef.current = null;
    liveRefreshRef.current = null;
    if (liveRefreshTimerRef.current !== null) {
      clearTimeout(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = null;
    }
    setState(null);
    setModelsLoading(false);
    if (sessionPath !== null) {
      // A draft is a placeholder path: it is the identity this state is held
      // under (so a `/plan` typed before the session exists has somewhere to
      // live), but there is no session to ask about yet. The real path replaces
      // it a moment later and the load happens then.
      if (!isDraftSession(sessionPath)) void loadSession(sessionPath, false);
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

  // Context usage changes throughout a streamed turn. Refresh on the first
  // meaningful frame and then at a modest cadence; the timer and single-flight
  // guard prevent one HTTP request per token while keeping the chip live.
  useEffect(() => {
    if (sessionPath === null) return;
    const unsubscribe = sessionEvents.subscribe((payload) => {
      if (payload.sessionPath !== sessionPath) return;
      const type = payload.event.type;
      if (type === "message_update" || type === "message_end" || type === "tool_execution_end") {
        scheduleLiveRefresh(sessionPath);
      }
      if (type === "agent_settled") {
        if (liveRefreshTimerRef.current !== null) {
          clearTimeout(liveRefreshTimerRef.current);
          liveRefreshTimerRef.current = null;
        }
        void refreshLive(sessionPath);
      }
    });
    return () => {
      unsubscribe();
      if (liveRefreshTimerRef.current !== null) {
        clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
    };
  }, [sessionPath, refreshLive, scheduleLiveRefresh]);

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

  const selectThinking = useCallback(
    async (level: string): Promise<void> => {
      const path = sessionPath;
      if (path === null) {
        // Nothing to switch yet: remember the choice, and `createSession`
        // applies it when the first message creates the session.
        actions.setNewSessionThinkingLevel(level);
        return;
      }
      try {
        apply(path, await api.setSessionThinking(path, level));
      } catch (err) {
        actions.setNotice((err as Error).message);
      }
    },
    [sessionPath, apply],
  );

  /**
   * The hero's level, when it has one: the same override rule as the model, but
   * keyed on the level string rather than a model identity.
   */
  const shown =
    overridden !== null && sessionPath === null && newSessionThinkingLevel !== null
      ? { ...overridden, thinkingLevel: newSessionThinkingLevel }
      : overridden;

  const selectPreset = useCallback(
    async (presetId: string): Promise<void> => {
      const path = sessionPath;
      if (path === null) {
        // Nothing to recompose yet: remember the choice, and `createSession`
        // hands it to the process it starts. The default is stored as null so
        // "not chosen" and "chose the default" stay one state.
        actions.setNewSessionPresetId(presetId === DEFAULT_PRESET_ID ? null : presetId);
        return;
      }
      try {
        // The answer is the recomposed session's own composer state, so the
        // label, the model figures and the lock all move together in one write.
        apply(path, await api.recomposeSession(path, presetId));
      } catch (err) {
        actions.setNotice((err as Error).message);
      }
    },
    [sessionPath, apply],
  );

  /** Record an authoritative plan-mode answer, dropping any local one. */
  const applyPlan = useCallback(
    (active: boolean): void => {
      const path = sessionPath;
      if (path === null || sourceRef.current !== path) return;
      const current = stateRef.current;
      if (current === null) {
        // No read has landed yet (a draft, or a switch before the first read):
        // the value waits as the pending one, which the next read cannot
        // contradict — see `apply`.
        planPendingRef.current = active;
        return;
      }
      planPendingRef.current = null;
      apply(path, { ...current, planMode: active });
    },
    [sessionPath, apply],
  );

  const selectPlan = useCallback(
    async (active: boolean): Promise<void> => {
      const path = sessionPath;
      // Plan mode belongs to a session that exists; the hero has nowhere to put
      // it and shows no control for it either.
      if (path === null) throw new Error("no session to switch");
      // Deliberately not swallowed into a notice: the only caller is the plan
      // chip, which says a failed exit beside itself (dsh puts it there too).
      const { planMode } = await api.setSessionPlan(path, active);
      // The answer is the process's own view (see the server's `planModeNow`),
      // so it settles any local value on the spot.
      applyPlan(planMode);
    },
    [sessionPath, applyPlan],
  );

  /**
   * Ask the running session what plan mode it holds, and settle on that.
   *
   * Called right after a `/plan` command is sent: the command flips a mode the
   * session file may not be able to record yet (pi writes one lazily), so the
   * chip must not depend on a read that has nothing to read. A session with no
   * process yet answers nothing, which is why the value stays local until there
   * is one — see `markPlan`.
   */
  const syncPlan = useCallback(async (): Promise<void> => {
    const path = sessionPath;
    if (path === null || isDraftSession(path)) return;
    try {
      const { planMode } = await api.getSessionPlan(path);
      applyPlan(planMode);
    } catch {
      // No process to ask: the local value stands, and the session becoming real
      // is what triggers another ask.
    }
  }, [sessionPath, applyPlan]);

  const markPlan = useCallback(
    (active: boolean): void => {
      const path = sessionPath;
      if (path === null || sourceRef.current !== path) return;
      planPendingRef.current = active;
      // A draft has no composer read at all — there is nothing to ask — so the
      // switch is the only thing this state holds until the session is real.
      const base: ComposerState = stateRef.current ?? {
        live: false,
        model: null,
        models: null,
        context: null,
        thinkingLevel: null,
      };
      apply(path, { ...base, planMode: active });
    },
    [sessionPath, apply],
  );

  /*
   * Memoised on the three things it is built from, so a render of the caller
   * that changed none of them hands back the same object. Without this, every
   * commit anywhere in the composer produced a fresh `state`, which re-rendered
   * the model card — and a re-rendered `EffortSlider` is a re-created one: its
   * held drag preview is component state, so the disc snapped back for the
   * length of the round trip.
   */
  const value = useMemo(
    () => ({
      state: shown,
      modelsLoading,
      ensureLive,
      selectModel,
      selectThinking,
      selectPreset,
      selectPlan,
      markPlan,
      syncPlan,
    }),
    [shown, modelsLoading, ensureLive, selectModel, selectThinking, selectPreset, selectPlan, markPlan, syncPlan],
  );

  return value;
}
