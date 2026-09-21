import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ChevronIcon, FolderIcon, SendIcon } from "../../components/icons.tsx";
import { actions, appStore } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { SlashMenu } from "./SlashMenu.tsx";
import { useSlashCompletion } from "./useSlashCompletion.ts";
import styles from "./NewSessionHero.module.css";

/** Workspace chooser shown above the composer. */
function WorkspaceSelect() {
  const state = useStore(appStore);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = state.projects.find((project) => project.id === state.selectedProjectId);

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

  return (
    <div className={styles.selector} ref={rootRef}>
      <button
        type="button"
        className={styles.selectorButton}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.selectorGlyph}>
          <FolderIcon />
        </span>
        {current ? current.title : "选择工作区"}
        <span className={styles.selectorCaret}>
          <ChevronIcon />
        </span>
      </button>

      {open ? (
        <div className={styles.menu} role="listbox">
          {state.projects.length === 0 ? (
            <p className={styles.warning}>还没有工作区</p>
          ) : (
            state.projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={project.id === state.selectedProjectId}
                className={clsx(
                  styles.menuItem,
                  project.id === state.selectedProjectId && styles.menuItemActive,
                )}
                title={project.path}
                onClick={() => {
                  void actions.selectProject(project.id);
                  actions.expandProject(project.id);
                  setOpen(false);
                }}
              >
                <span className={styles.selectorGlyph}>
                  <FolderIcon />
                </span>
                <span>{project.title}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The empty state shown when no conversation is open, modelled on dsh's hero:
 * brand mark, workspace chooser, and a large composer. The first message
 * creates the session and is delivered to it.
 */
export function NewSessionHero() {
  const state = useStore(appStore);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId);
  // The hero opens a *new* session, while every built-in command acts on an
  // existing one (/compact, /export, /session, /name), so offering them here
  // would just be a menu of things that cannot work yet.
  const commands = (
    state.selectedProjectId ? (state.commands[state.selectedProjectId] ?? []) : []
  ).filter((command) => command.source !== "builtin");
  const completion = useSlashCompletion({ setText, textareaRef, commands });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const submit = (): void => {
    const message = text.trim();
    if (message.length === 0 || !project) return;
    setText("");
    // Creates the draft immediately and queues the message for the session
    // that replaces it once pi is ready.
    actions.startDraftSession(project.id, message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the command menu is open it owns the arrow keys, Enter/Tab and
    // Escape, so Enter completes a command instead of starting a session.
    if (completion.onKeyDown(event)) return;

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.titleRow}>
          <span className={styles.mark} aria-hidden>
            π
          </span>
          <h1 className={styles.title}>开始新的会话</h1>
          <span className={styles.badge}>预览版</span>
        </div>

        <div className={styles.selectors}>
          <WorkspaceSelect />
        </div>

        <div className={styles.composer}>
          {completion.open ? (
            <SlashMenu
              matches={completion.matches}
              highlight={completion.highlight}
              onHighlight={completion.setHighlight}
              onSelect={completion.select}
            />
          ) : null}

          <textarea
            ref={textareaRef}
            className={styles.input}
            value={text}
            rows={2}
            spellCheck={false}
            disabled={!project}
            placeholder={project ? "描述你想要完成的任务，/ 调用命令" : "先添加一个工作区"}
            aria-label="新会话的第一条消息"
            onChange={(event) => {
              setText(event.target.value);
              completion.sync();
            }}
            onKeyUp={() => completion.sync()}
            onClick={() => completion.sync()}
            onKeyDown={onKeyDown}
          />
          <div className={styles.toolbar}>
            <span className={styles.toolbarHint}>Enter 发送 · Shift+Enter 换行</span>
            <button
              type="button"
              className={styles.send}
              disabled={!project || text.trim().length === 0}
              aria-label="开始会话"
              title="开始会话"
              onClick={submit}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
