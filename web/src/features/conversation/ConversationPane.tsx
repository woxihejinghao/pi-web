import { useCallback, useState } from "react";
import { AlertIcon, RefreshIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import { actions, appStore, isDraftSession } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { Composer } from "./Composer.tsx";
import { SessionStats } from "./SessionStats.tsx";
import { MessageList } from "./MessageList.tsx";
import { NewSessionHero } from "./NewSessionHero.tsx";
import { parseBuiltinCommand } from "./slash.ts";
import { TodoPanel } from "./TodoPanel.tsx";
import { TreeDialog } from "./TreeDialog.tsx";
import { useConversation } from "./useConversation.ts";
import styles from "./ConversationPane.module.css";

export function ConversationPane() {
  const state = useStore(appStore);
  const [treeOpen, setTreeOpen] = useState(false);
  // A draft has no pi process yet, so the conversation runs without a path
  // until the spawn resolves and swaps the real one in.
  const selected = state.selectedSessionPath;
  const draft = isDraftSession(selected);
  const sessionPath = draft ? null : selected;

  const conversation = useConversation(sessionPath);

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
    async (text: string, mode: "prompt" | "steer" | "followUp"): Promise<boolean> => {
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

      if (sessionPath) return conversation.send(text, mode);
      if (!draft) return false;
      const realPath = await actions.resolveDraftSession();
      if (!realPath) return false;
      actions.queuePendingPrompt(realPath, text, mode);
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
        actions.setNotice(`已从「${label}」分叉为新会话。「${label}」之后的轮次仍留在原会话里。`);
      })
      .catch((err: Error) => actions.setNotice(err.message));
  };

  // Nothing open: show the new-session hero instead of a header + empty list.
  if (!sessionPath && !draft) {
    return (
      <div className={styles.pane}>
        <NewSessionHero />
      </div>
    );
  }

  const headerSub = draft
    ? "正在准备会话…"
    : sessionPath
      ? (session?.title ?? "会话")
      : "未选择会话";

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>{project?.title ?? "pi-web-simple"}</span>
        <span className={styles.headerSub}>{headerSub}</span>
        {draft ? <span className={styles.spinner} aria-hidden /> : null}
        {sessionPath !== null && !draft ? (
          <button
            type="button"
            className={styles.headerAction}
            onClick={() => setTreeOpen(true)}
          >
            <Glyph name="branch" size={14} />
            话题树
          </button>
        ) : null}
      </header>

      {treeOpen && sessionPath !== null ? (
        <TreeDialog
          sessionPath={sessionPath}
          onFork={(entryId) => {
            setTreeOpen(false);
            onFork(entryId);
          }}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}

      {isExternal ? (
        <div className={styles.banner} role="status">
          <span className={styles.bannerIcon}>
            <AlertIcon />
          </span>
          <span className={styles.bannerText}>
            这个会话被其他进程（例如终端的 pi）修改过，当前内容可能已过期。
          </span>
          <button type="button" className={styles.bannerAction} onClick={() => void reload()}>
            <RefreshIcon />
            重新载入
          </button>
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
        compactTranscript={state.settings.transcriptDisplay === "compact"}
        onFork={onFork}
      />
      {/* Between transcript and composer, where dsh puts its plan strip: the
          list belongs to the input it is about to steer, not to the history. */}
      <TodoPanel todos={conversation.todos} />
      <Composer
        isStreaming={conversation.isStreaming}
        disabled={conversation.loading}
        commands={commands}
        busySendBehavior={state.settings.busySendBehavior}
        onSend={sendMessage}
        onAbort={() => void conversation.abort()}
      />
      {/* Under the composer, where dsh puts its two stat pills: they describe
          the session the input is being typed into, not the transcript above. */}
      <SessionStats stats={conversation.stats} />
    </div>
  );
}
