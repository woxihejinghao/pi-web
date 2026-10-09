import { useCallback } from "react";
import { AlertIcon, RefreshIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import { actions, appStore, isDraftSession, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { rightbarActions, rightbarStore } from "../rightbar/rightbar-state.ts";
import { publishTurnChanges, type TurnChanges } from "../rightbar/turn-changes-store.ts";
import { PanelRightIcon } from "../rightbar/rightbar-icons.tsx";
import { shortcutTitle } from "../rightbar/shortcuts.ts";
import type { ImageBlock } from "../../lib/types.ts";
import { Composer } from "./Composer.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { SessionStats } from "./SessionStats.tsx";
import { MessageList } from "./MessageList.tsx";
import { NewSessionHero } from "./NewSessionHero.tsx";
import { parseBuiltinCommand } from "./slash.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { useComposerState } from "./useComposerState.ts";
import { useConversation } from "./useConversation.ts";
import styles from "./ConversationPane.module.css";

export function ConversationPane() {
  const t = useT();
  const state = useStore(appStore);
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
  // The model picker and context ring describe the session the text goes into.
  // They read from the session file until a pi process is needed, which is only
  // when the user actually opens one of them — see `useComposerState`.
  const composer = useComposerState({ sessionPath, projectId: null });

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

  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId);
  const sessions = state.selectedProjectId ? (state.sessions[state.selectedProjectId] ?? []) : [];
  const session = sessions.find((candidate) => candidate.path === selected);
  const isExternal = selected ? Boolean(state.externalChanged[selected]) : false;
  const commands = state.selectedProjectId ? (state.commands[state.selectedProjectId] ?? []) : [];

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
          actions.setNotice(result.message);
        } catch (err) {
          actions.setNotice(`/${builtin.command.name}：${(err as Error).message}`);
        }
        // Compaction and renames change what the transcript reports.
        await conversation.reload();
        return true;
      }

      if (sessionPath) return conversation.send(text, mode, images);
      if (!draft) return false;
      const realPath = await actions.resolveDraftSession();
      if (!realPath) return false;
      actions.queuePendingPrompt(realPath, text, mode, images);
      return true;
    },
    [sessionPath, draft, conversation, commands],
  );

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
  // the next message would have been typed. The open session's own request
  // wins the seat; a request from another session still appears, because that
  // process is just as blocked, and carries a jump line instead.
  const pendingUi =
    state.pendingUiRequests.find((item) => item.sessionPath === sessionPath) ??
    state.pendingUiRequests[0] ??
    null;
  const pendingSession =
    pendingUi && pendingUi.sessionPath !== sessionPath
      ? Object.values(state.sessions)
          .flat()
          .find((candidate) => candidate.path === pendingUi.sessionPath)
      : undefined;
  const questionCard = pendingUi ? (
    <QuestionCard
      // The request id is the card's identity, and only that: a draft session
      // swaps its provisional path for the real one a second after the spawn
      // resolves, and keying on the session path would remount the card and
      // throw away the row the user had already picked.
      key={pendingUi.request.id}
      pending={pendingUi}
      sessionLabel={pendingSession?.title}
      onOpenSession={
        pendingSession ? () => actions.selectSession(pendingUi.sessionPath) : undefined
      }
    />
  ) : null;

  // Nothing open: show the new-session hero instead of a header + empty list.
  if (!sessionPath && !draft) {
    return (
      <div className={styles.pane}>
        {/* macOS only (the rule hides it elsewhere): with no Session there is no
            header, so this empty row keeps the center column's window-drag band
            over the hero. */}
        <header className={styles.headerBlank} data-window-drag aria-hidden />
        <NewSessionHero />
        {questionCard}
      </div>
    );
  }

  const headerSub = draft
    ? t("pane.preparing")
    : sessionPath
      ? (session?.title ?? t("pane.session"))
      : t("pane.noSession");

  return (
    <div className={styles.pane}>
      <header className={styles.header} data-window-drag>
        <span className={styles.headerTitle}>{project?.title ?? "pi-web-simple"}</span>
        <span className={styles.headerSub}>{headerSub}</span>
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
              onTurnChanges: publishChanges,
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
                  loading: composer.modelsLoading,
                  onRequestLive: () => void composer.ensureLive(),
                  onSelectModel: (provider, id) => void composer.selectModel(provider, id),
                }
          }
          onSend={sendMessage}
          onAbort={() => void conversation.abort()}
          workspacePath={project?.path}
        />
      )}
      {/* Under the composer, where dsh puts its two stat pills: they describe
          the session the input is being typed into, not the transcript above. */}
      <SessionStats stats={conversation.stats} />
    </div>
  );
}
