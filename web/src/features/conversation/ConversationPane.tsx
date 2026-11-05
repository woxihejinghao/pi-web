import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertIcon, PanelLeftIcon, RefreshIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import { actions, appStore, commandsKey, isDraftSession, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { presetDescription, presetName } from "../../lib/presets.ts";
import { rightbarActions, rightbarStore } from "../rightbar/rightbar-state.ts";
import { isImageName } from "../rightbar/file-kind.ts";
import { layoutActions, layoutStore, sidebarGeometry } from "../../layout/layout-state.ts";
import { publishTurnChanges, type TurnChanges } from "../rightbar/turn-changes-store.ts";
import {
  publishPlans as publishPlansToStore,
  rememberTemporaryPlan,
} from "../rightbar/plan-store.ts";
import { REVIEW_TARGET_PREFIX } from "../rightbar/rightbar-state.ts";
import type { PlanReviewTarget } from "./QuestionComposer.tsx";
import type { PlanDoc } from "./plan-docs.ts";
import { PanelRightIcon } from "../rightbar/rightbar-icons.tsx";
import { shortcutTitle } from "../rightbar/shortcuts.ts";
import { DEFAULT_PRESET_ID, type ImageBlock } from "../../lib/types.ts";
import { Composer } from "./Composer.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { QuestionComposer } from "./QuestionComposer.tsx";
import { PendingQuestions } from "./PendingQuestions.tsx";
import { QueueDock } from "./QueueDock.tsx";
import { askUserQuestions, pendingUiForSession } from "./question-model.ts";
import { SessionStats } from "./SessionStats.tsx";
import { MessageList } from "./MessageList.tsx";
import { ConversationWidthControls } from "./ConversationWidthControls.tsx";
import { NewSessionHero } from "./NewSessionHero.tsx";
import { extensionCommandName, parseBuiltinCommand, planCommandOf, unknownCommandName } from "./slash.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { useComposerState } from "./useComposerState.ts";
import { useConversation } from "./useConversation.ts";
import styles from "./ConversationPane.module.css";

/**
 * Built-in commands whose outcome the transcript already reports.
 *
 * `/compact` is the only one, and the reason is positional: running it lands a
 * checkpoint row in the conversation at the point the cut was made (see
 * `useConversation`). Toasting the same news a moment later — a different
 * number, in a different corner of the screen — reads as a second event. Every
 * other built-in has nothing else to show for itself: an export path, a rename,
 * a stats summary live only in that one line.
 */
const TRANSCRIPT_REPORTED_COMMANDS: ReadonlySet<string> = new Set(["compact"]);

/**
 * The composition chooser, for a session whose composition is not fixed yet.
 *
 * A preset is the arguments pi was started with, so changing it means a new
 * process; the server allows that only while the session has recorded no leading
 * system message (see `POST /api/sessions/:id/preset`), which is dsh's
 * `agent-preset-locked` in pi's own evidence. The same chip becomes a plain
 * label once that window closes, so the header neither grows nor loses a
 * control — it just stops opening.
 */
function PresetSwitch({
  current,
  onSelect,
}: {
  current: string;
  onSelect: (presetId: string) => void;
}) {
  const t = useT();
  const state = useStore(appStore);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const presets = state.agentPresets ?? [];
  // One composition is not a choice, and before the roster lands there is
  // nothing to switch to either: a chip that can only repeat itself reads as a
  // control that does nothing.
  if (presets.length <= 1) return null;

  return (
    <div className={styles.headerPresetPicker} ref={rootRef}>
      <button
        type="button"
        className={styles.headerPresetButton}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t("preset.choose")}
        title={t("pane.presetSwitchable")}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{presetName(t, current)}</span>
      </button>
      {open ? (
        <div className={styles.headerPresetMenu} role="listbox">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={preset.id === current}
              className={clsx(
                styles.headerPresetItem,
                preset.id === current && styles.headerPresetItemActive,
              )}
              title={presetDescription(t, preset.id)}
              onClick={() => {
                setOpen(false);
                onSelect(preset.id);
              }}
            >
              <span>{presetName(t, preset.id)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConversationPane() {
  const t = useT();
  const state = useStore(appStore);
  // The width axis lives on the pane root; the drag strips read it through
  // this ref and publish the measured column width back onto it.
  const paneRef = useRef<HTMLDivElement>(null);
  // A draft has no pi process yet, so the conversation runs without a path
  // until the spawn resolves and swaps the real one in.
  const selected = state.selectedSessionPath;
  const draft = isDraftSession(selected);
  const sessionPath = draft ? null : selected;

  const conversation = useConversation(sessionPath);
  // The right sidebar's state is per session, so the header's toggle reads the
  // same surface the panel itself does. It is drawn only while the panel is
  // hidden — when it is open, the panel's own strip carries the collapse
  // control, and a second one would be a second way to say the same thing.
  const rightbarState = useStore(rightbarStore);
  const rightbarOpen = rightbarState.surfaces[selected ?? ""]?.open === true;
  // The header's sidebar toggle states whether the column is on screen, which
  // is two different questions in the two presentations: on a narrow frame the
  // column takes no track at all and "shown" means the drawer is out.
  const sidebar = sidebarGeometry(useStore(layoutStore));
  const sidebarShown = sidebar.overlay || sidebar.width > 0;
  // The model picker and context ring describe the session the text goes into.
  // They read from the session file until a pi process is needed, which is only
  // when the user actually opens one of them — see `useComposerState`.
  // The selected path, draft included: a draft is where a `/plan` typed before
  // the session exists has to live (see `useComposerState`), and it becomes
  // the real path a moment later.
  const composer = useComposerState({ sessionPath: selected, projectId: null });

  /**
   * Hand each turn's changed files to the review tabs.
   *
   * The sidebar has no way to reach the transcript, so the pane that holds it
   * publishes. The session is bound here rather than on every call site, and the
   * callback is stable so `MessageList`'s effect does not refire on each render.
   */
  const publishChanges = useCallback(
    (changes: readonly TurnChanges[]) => {
      if (sessionPath !== null) publishTurnChanges(sessionPath, changes);
    },
    [sessionPath],
  );

  /**
   * Hand each submitted plan to the plan tabs, and open one when asked.
   *
   * The same bridge as the review tabs, for the documents `exit_plan_mode`
   * wrote: the conversation owns the transcript, the sidebar owns a tab, and
   * `plan-store` is where they meet. Both are keyed by the plan's `callId`, so
   * the card, the review's link and a restored tab all name the same document.
   */
  const publishPlans = useCallback(
    (plans: readonly PlanDoc[]) => {
      if (sessionPath !== null) publishPlansToStore(sessionPath, plans);
    },
    [sessionPath],
  );
  const openPlan = useCallback(
    (plan: PlanDoc) => {
      if (sessionPath !== null) rightbarActions.openPlanTab(sessionPath, plan.callId, plan.title);
    },
    [sessionPath],
  );

  /**
   * Plan mode, as the session's own log records it.
   *
   * A stance rather than a composition: it can be switched at any point, and
   * the switch is a pi extension command, so the chip reports what the file
   * says after the round trip instead of predicting it. It is drawn only for a
   * session that exists — plan mode has nothing to attach to in the hero — and
   * the chip itself draws only while the mode is on (dsh's rule: entering is
   * `/plan`, the chip is the way out).
   */
  /**
   * Leave plan mode.
   *
   * The chip's job, and it is an extension command either way: a real session
   * runs it through the switch endpoint (which answers with the process's own
   * view), while a draft has no process to run it in — so the exit is queued like
   * any other message and the chip goes out locally now.
   */
  const exitPlan = useCallback(async (): Promise<void> => {
    if (sessionPath !== null) return composer.selectPlan(false);
    const realPath = await actions.resolveDraftSession();
    composer.markPlan(false);
    if (realPath !== null) actions.queuePendingPrompt(realPath, "/plan off", "prompt", []);
  }, [sessionPath, composer]);

  const plan = selected !== null
    ? { active: composer.state?.planMode === true, onExit: exitPlan }
    : undefined;

  /**
   * Open a review's plan in the right sidebar, returning whether it landed.
   *
   * A logged plan is addressed by its `exit_plan_mode` call and the tab reads it
   * back out of the transcript; one with no call exists only in the card, so the
   * document is remembered under the request's own key and the address says so
   * (see `plan-store.ts`). `false` means there was no sidebar to address yet —
   * the caller keeps its automatic open pending.
   */
  const openPlanFromReview = useCallback(
    (target: PlanReviewTarget): boolean => {
      if (sessionPath === null) return false;
      if (target.callId !== undefined) {
        rightbarActions.openPlanTab(sessionPath, target.callId, target.title);
        return true;
      }
      if (target.requestId === undefined) return false;
      rememberTemporaryPlan(target.requestId, { title: target.title, plan: target.plan });
      rightbarActions.openPlanTab(
        sessionPath,
        `${REVIEW_TARGET_PREFIX}${target.requestId}`,
        target.title,
      );
      return true;
    },
    [sessionPath],
  );

  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId);
  /**
   * Where a referenced picture's bytes come from.
   *
   * Built here rather than inside the transcript because it needs the project —
   * and because "is this an image?" is a property of the deployment's file
   * service, not of a sentence. `/raw` streams the bytes so the `<img>` can
   * cache and decode them itself; a path the server would not serve as a picture
   * simply gets no hover preview.
   */
  const projectId = project?.id;
  const imageUrlFor = useCallback(
    (path: string): string | undefined =>
      projectId === undefined || !isImageName(path)
        ? undefined
        : api.workspaceRawUrl(projectId, path, sessionPath ?? undefined),
    [projectId, sessionPath],
  );
  const sessions = state.selectedProjectId ? (state.sessions[state.selectedProjectId] ?? []) : [];
  const session = sessions.find((candidate) => candidate.path === selected);
  const isExternal = selected ? Boolean(state.externalChanged[selected]) : false;
  /**
   * The composition this conversation runs, and the commands that come with it.
   *
   * A menu drawn from "the project's commands" would offer a minimal session
   * the extensions and skills it does not have, so the list is read under the
   * composition's own key (see `commandsKey`). While a draft has no composer
   * state yet, the hero's own pick is the best answer available: the process
   * was started with it a moment ago.
   */
  const presetId =
    composer.state?.presetId ??
    (draft ? (state.newSessionPresetId ?? DEFAULT_PRESET_ID) : DEFAULT_PRESET_ID);
  /**
   * The composition the composer has read back, if it has.
   *
   * Kept apart from `presetId` so waiting for it does not make the fallback
   * itself look like an answer: a session's real composition arrives with the
   * composer read, and asking for the default in the meantime would spend a
   * request — and a prewarm — on a process this session is not running.
   */
  const readPresetId = composer.state?.presetId;
  const commandScope = state.selectedProjectId
    ? commandsKey(state.selectedProjectId, presetId)
    : null;
  const commands = commandScope !== null ? (state.commands[commandScope] ?? []) : [];
  /**
   * False until that composition's listing has landed, and false again while
   * it is partial.
   *
   * An unloaded list must not be read as "nothing is registered", or every
   * command typed in the first second of a session would be reported missing.
   * A partial one — the server's built-ins, no pi process behind them — is the
   * same false negative for skills and templates, so it does not count as the
   * answer either.
   */
  const commandsLoaded =
    commandScope !== null &&
    state.commands[commandScope] !== undefined &&
    state.commandsPartial[commandScope] !== true;
  // Ask for that composition's commands as soon as it is known. The listing is
  // cached per composition, so two sessions of one workspace that share a
  // composition cost one request between them.
  useEffect(() => {
    if (state.selectedProjectId === null) return;
    // A draft has no composer read of its own, so the hero's pick stands in;
    // every other session waits for its own answer rather than guessing.
    if (!draft && readPresetId === undefined) return;
    void actions.loadCommands(state.selectedProjectId, presetId);
  }, [state.selectedProjectId, readPresetId, draft, presetId]);

  /**
   * A message typed before the spawn finished is queued for the real session
   * and delivered by the conversation instance that mounts for it.
   */
  const sendMessage = useCallback(
    async (text: string, mode: "prompt" | "steer" | "followUp", images: ImageBlock[] = []): Promise<boolean> => {
      // A built-in command is not a message. It maps to its own RPC method, so
      // it runs here and never reaches the model.
      const builtin = parseBuiltinCommand(text, commands);
      if (builtin) {
        const target = sessionPath ?? (draft ? await actions.resolveDraftSession() : null);
        if (!target) return false;
        try {
          const result = await api.runBuiltinCommand(target, builtin.command.name, builtin.args);
          if (!TRANSCRIPT_REPORTED_COMMANDS.has(builtin.command.name)) {
            actions.setNotice(result.message);
          }
        } catch (err) {
          // A failure has no row to land in, so it still speaks up.
          actions.setNotice(`/${builtin.command.name}：${(err as Error).message}`);
        }
        // No reload: `/compact` lands its checkpoint through the event stream,
        // at the point it was made (see `useConversation`), and re-reading the
        // transcript here would replace that with the compacted context — the
        // folded turns gone and the row pushed up to the very top, which is the
        // one place the reader is not looking.
        return true;
      }

      // An extension command is the third kind of slash text, and the only one
      // pi records no user turn for: it consumes the command and writes only
      // what the command itself submits. So it goes out without the optimistic
      // turn — pi's own message is adopted from the stream instead, and a
      // command that submits nothing (a bare `/plan`) leaves no row behind.
      // `/plan` is recognised by its own text rather than by waiting for the
      // command listing: a fresh session's list lands a second or two after the
      // composer becomes usable, and the mode switch must not depend on that race
      // (the listing also decides whether the optimistic turn is drawn, so losing
      // the race used to leave a message pi never recorded). Every other
      // extension command still needs the listing to know it is one.
      const wantsPlan = planCommandOf(text);
      const planCommand = wantsPlan !== null;
      // The mode flips locally first. pi writes a session lazily, so the file
      // cannot confirm a switch made before the first message, and a draft
      // session has no process to ask either — `syncPlan` settles it the moment
      // there is something authoritative to ask (see `useComposerState`).
      if (wantsPlan !== null) composer.markPlan(wantsPlan);

      const extension = planCommand && sessionPath !== null
        ? "plan"
        : commandsLoaded && sessionPath !== null
          ? extensionCommandName(text, commands)
          : null;
      if (extension !== null) {
        const sent = await conversation.runCommand(text, images);
        if (wantsPlan !== null) {
          // A command that landed is confirmed by the process, not by the file
          // it has not written yet; one that did not is rolled back.
          if (sent) void composer.syncPlan();
          else composer.markPlan(!wantsPlan);
        }
        return sent;
      }

      // A command nothing registered is not a command. pi would pass it through
      // to the model as ordinary text, which reads like a command that did
      // nothing — so say so, and still send it: the user may have meant the
      // text. Only once the listing has landed, since an empty list would
      // otherwise make every command look unregistered.
      const unknown = commandsLoaded ? unknownCommandName(text, commands) : null;
      if (unknown !== null) {
        actions.setNotice(t("composer.unknownCommand", { name: `/${unknown}` }));
      }

      if (sessionPath) return conversation.send(text, mode, images);
      if (!draft) return false;
      const realPath = await actions.resolveDraftSession();
      if (!realPath) return false;
      // A draft's command is queued with the flag that says so: when the session
      // appears it is sent as a command, not as the optimistic user turn a plain
      // prompt gets (pi never records the typed line for one).
      actions.queuePendingPrompt(realPath, text, mode, images, planCommand || extension !== null);
      return true;
    },
    [sessionPath, draft, conversation, composer, commands, commandsLoaded, t],
  );

  /**
   * Settle a plan switch once the session can answer for itself.
   *
   * A `/plan` typed in a session with no process yet (a draft, or one whose pi
   * has not started) is only local; the session becoming addressable is when a
   * process exists to ask. The callback is held in a ref so this runs on the
   * switch alone — depending on the composer object would re-ask on every read.
   */
  const syncPlanRef = useRef(composer.syncPlan);
  syncPlanRef.current = composer.syncPlan;
  useEffect(() => {
    if (sessionPath === null) return;
    // A `/plan` queued in a draft reaches pi a beat after the path appears, so
    // the first ask can be too early; one retry catches it. The local value
    // stands in the meantime — see `markPlan`.
    void syncPlanRef.current();
    const timer = window.setTimeout(() => void syncPlanRef.current(), 900);
    return () => window.clearTimeout(timer);
  }, [sessionPath]);

  const reload = async (): Promise<void> => {
    await conversation.reload();
    if (sessionPath) actions.clearExternalChanged(sessionPath);
  };

  /**
   * Fork at a user message.
   *
   * pi does not copy the session — it moves the session's leaf pointer back to
   * that entry, so the turns after it leave the visible transcript. They are not
   * lost (they stay in the file as a sibling branch, reachable through the
   * entry tree), but a user who forks and sees the rest of the conversation
   * vanish deserves to be told where it went rather than left to wonder.
   */
  const onFork = (entryId: string): void => {
    void conversation
      .fork(entryId)
      .then((result) => {
        // null means an extension vetoed the fork, which is its own answer.
        if (result === null) return;
        const label = result.text.replace(/\s+/g, " ").trim().slice(0, 30);
        // Follow the new branch: it is a separate session, so the app has to
        // switch to it and pick it up in the sidebar.
        actions.selectSession(result.sessionPath);
        void actions.refreshProjects().then(() => {
          // Reveal the project so the new session row is actually visible when
          // the sidebar re-renders.
          if (project !== undefined) actions.expandProject(project.id);
        });
        actions.setNotice(t("pane.forkedNotice", { label }));
      })
      .catch((err: Error) => actions.setNotice(err.message));
  };

  // A waiting dialog is a hard block on its pi process, so it takes the
  // composer's seat rather than floating over the page: the answer goes where
  // the next message would have been typed. Only the open session's own dialog
  // takes that seat — another session's is left to its sidebar row
  // (`pendingUiForSession` says why).
  const pendingUi = pendingUiForSession(state.pendingUiRequests, sessionPath);
  // A batched question gets the composer that can hold several answers; every
  // other dialog keeps the single-question card. Both take the composer seat,
  // so the choice is one branch at the render site and nothing else changes.
  const questionCard = pendingUi ? (
    pendingUi.request.method === "ask_user" ? (
      <QuestionComposer
        // The request id is the card's identity, and only that: a draft session
        // swaps its provisional path for the real one a second after the spawn
        // resolves, and keying on the session path would remount the card and
        // throw away the rows the user had already picked.
        key={pendingUi.request.id}
        requestId={pendingUi.request.id}
        // The server decoded the batch before publishing it (see the ask-user
        // codec), so this is already the card's own shape.
        questions={askUserQuestions(pendingUi.request)}
        title={typeof pendingUi.request.title === "string" ? pendingUi.request.title : undefined}
        timeoutMs={typeof pendingUi.request.timeout === "number" ? pendingUi.request.timeout : null}
        draftKey={pendingUi.request.id}
        onOpenPlan={openPlanFromReview}
        onSubmit={async (decision) => {
          const answered = await actions.respondToUiRequest(pendingUi.request.id, decision);
          if (!answered) return;
          // A plan review answers a mode switch as well as a verdict: approving
          // leaves plan mode, and the process knows that before any file does —
          // so ask it now instead of waiting for the next settled turn to read
          // the session back.
          void composer.syncPlan();
        }}
      />
    ) : (
      <QuestionCard
        // Same reason as above: the id is the identity, not the path.
        key={pendingUi.request.id}
        pending={pendingUi}
      />
    )
  ) : null;

  // Nothing open: show the new-session hero instead of a header + empty list.
  if (!sessionPath && !draft) {
    return (
      <div className={styles.pane}>
        {/* macOS only (the rule hides it elsewhere): with no Session there is no
            header, so this empty row keeps the center column's window-drag band
            over the hero. */}
        <header className={styles.headerBlank} data-window-drag aria-hidden />
        {/* The hero has no header of its own, so the toggle takes the same
            top-left seat as a floating control. Absolute rather than a row of
            its own: the hero centres itself in what is left of the column, and
            a row would push that centre off by its own height. */}
        <button
          type="button"
          className={styles.heroToggle}
          title={sidebarShown ? t("pane.sidebarHide") : t("pane.sidebarShow")}
          aria-label={sidebarShown ? t("pane.sidebarHide") : t("pane.sidebarShow")}
          aria-expanded={sidebarShown}
          onClick={() => layoutActions.toggleSidebar()}
        >
          <PanelLeftIcon width={14} height={14} />
        </button>
        <NewSessionHero />
        {questionCard}
      </div>
    );
  }

  const headerSub = draft
    ? t("pane.preparing")
    : sessionPath
      ? (session?.title ?? state.unsavedSessionTitles[sessionPath] ?? t("pane.session"))
      : t("pane.noSession");

  /**
   * The composition, as a control while that is still possible and a label
   * after.
   *
   * A preset is the arguments pi was spawned with, so choosing one normally
   * belongs to the new-session page. It stays changeable for exactly as long as
   * the session holds no leading system message — the server's own line, which
   * is dsh's `agent-preset-locked` measured in pi's evidence. Past that point
   * the value is a fact about the session, and the badge says so rather than
   * offering a control the server would refuse.
   *
   * "Standard" is what the absence of a badge means, so a locked default session
   * carries nothing at all.
   */
  const presetLocked = composer.state?.presetLocked ?? true;
  const presetBadge = !presetLocked ? (
    <PresetSwitch current={presetId} onSelect={(id) => void composer.selectPreset(id)} />
  ) : presetId !== DEFAULT_PRESET_ID ? (
      <span className={styles.headerPreset} title={t("pane.presetLocked")}>
        {presetName(t, presetId)}
      </span>
    ) : null;

  return (
    <div className={styles.pane} ref={paneRef}>
      {/* The transcript width axis: measured here, dragged at the gutters,
          consumed by the column and composer as --conversation-content-width. */}
      <ConversationWidthControls hostRef={paneRef} />
      <header className={styles.header} data-window-drag>
        <button
          type="button"
          className={styles.headerIconAction}
          title={sidebarShown ? t("pane.sidebarHide") : t("pane.sidebarShow")}
          aria-label={sidebarShown ? t("pane.sidebarHide") : t("pane.sidebarShow")}
          aria-expanded={sidebarShown}
          onClick={() => layoutActions.toggleSidebar()}
        >
          <PanelLeftIcon width={14} height={14} />
        </button>
        <span className={styles.headerTitle}>{project?.title ?? "pi-web-simple"}</span>
        <span className={styles.headerSub}>{headerSub}</span>
        {presetBadge}
        {draft ? <span className={styles.spinner} aria-hidden /> : null}
        {sessionPath !== null && !draft && !rightbarOpen ? (
          <button
            type="button"
            className={styles.headerPanelAction}
            title={shortcutTitle(t, t("pane.openRightbar"), "rightbar.toggle")}
            aria-label={t("pane.openRightbar")}
            onClick={() => rightbarActions.open(sessionPath)}
          >
            <PanelRightIcon width={14} height={14} />
          </button>
        ) : null}
      </header>

      {isExternal ? (
        <div className={styles.banner} role="status">
          <span className={styles.bannerIcon}>
            <AlertIcon />
          </span>
          <span className={styles.bannerText}>{t("pane.stale")}</span>
          <button type="button" className={styles.bannerAction} onClick={() => void reload()}>
            <RefreshIcon />{t("pane.reload")}</button>
        </div>
      ) : null}

      {conversation.error ? (
        <div className={styles.errorBanner} role="alert">
          {conversation.error}
        </div>
      ) : null}

      <MessageList
        view={conversation}
        sessionPath={sessionPath}
        cwd={project?.path}
        home={state.home}
        transcriptView={state.settings.transcriptDisplay}
        onFork={onFork}
        {...(sessionPath === null
          ? {}
          : {
              // A turn's changed files open that turn's review in the sidebar —
              // dsh's review tab, where the comparison, the other files of the
              // turn and the way into the whole file all live. The panel opens
              // itself if it was collapsed, so the click always lands somewhere
              // visible.
              onOpenChanges: (turn: number, index: number) =>
                rightbarActions.openTurnChangesTab(sessionPath, turn, index),
              // A file an answer points at opens the same way, at the lines the
              // reference asked for — the panel is where the file lives, and the
              // chip is only the way in.
              onOpenFile: (path: string, position: { line?: number; endLine?: number }) =>
                rightbarActions.openFileRef(sessionPath, path, position),
              onImageUrl: imageUrlFor,
              onTurnChanges: publishChanges,
              onPlans: publishPlans,
              onOpenPlan: openPlan,
              // pi has no "try that turn again" RPC — its own retry loop is the
              // only one it offers, and it runs inside a turn. Re-sending the
              // prompt is the lever that exists, and it costs a second copy of
              // the user's message because that is genuinely what is sent. A
              // second `prompt` while pi is running is rejected outright, so a
              // busy session takes the retry as a queued follow-up instead —
              // the same choice the composer makes, minus the setting.
              onRetry: (text: string, images: ImageBlock[]) =>
                void conversation.send(text, conversation.isStreaming ? "followUp" : "prompt", images),
            })}
      />
      {/* Between transcript and composer, where dsh puts its plan strip: the
          list belongs to the input it is about to steer, not to the history. */}
      <TodoPanel todos={conversation.todos} />
      {/* A batch whose deadline passed is still answerable, but nothing is
          blocked behind it — so it waits in a strip above the input instead of
          taking the seat the live card takes. */}
      <PendingQuestions
        questions={conversation.pendingQuestions}
        suspended={pendingUi !== null}
        onAnswer={async (text) => {
          const sent = await conversation.send(text, conversation.isStreaming ? "followUp" : "prompt");
          // A refused send must not look like a submitted answer or clear its
          // saved draft. QuestionComposer surfaces this rejection in its footer.
          if (!sent) throw new Error(t("question.answerSendFailed"));
        }}
      />
      {/* The sends pi has not taken up yet, with the exits the transcript rows
          cannot offer: drop one, or fix a typo before the model ever sees it.
          dsh seats its queue dock on the input card; this sits beside the other
          strips for the same reason they do. */}
      <QueueDock queue={conversation.queue} onRemove={conversation.queueRemove} onEdit={conversation.queueEdit} />
      {/* One seat, two occupants: a pending question replaces the input rather
          than stacking above it, so the card cannot be confused for a message
          that has already been sent. */}
      {questionCard ?? (
        <Composer
          isStreaming={conversation.isStreaming}
          disabled={conversation.loading}
          commands={commands}
          busySendBehavior={state.settings.busySendBehavior}
          session={
            sessionPath === null
              ? undefined
              : {
                  model: composer.state?.model ?? null,
                  models: composer.state?.models ?? null,
                  context: composer.state?.context ?? null,
                  thinkingLevel: composer.state?.thinkingLevel ?? null,
                  loading: composer.modelsLoading,
                  live: composer.state?.live ?? false,
                  onRequestLive: () => void composer.ensureLive(),
                  onSelectModel: (provider, id) => void composer.selectModel(provider, id),
                  onSelectThinking: (level) => void composer.selectThinking(level),
                }
          }
          onSend={sendMessage}
          onAbort={() => void conversation.abort()}
          plan={plan}
          workspacePath={project?.path}
        />
      )}
      {/* Under the composer, where dsh puts its two stat pills: they describe
          the session the input is being typed into, not the transcript above. */}
      <SessionStats stats={conversation.stats} />
    </div>
  );
}
