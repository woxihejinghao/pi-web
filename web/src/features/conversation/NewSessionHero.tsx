import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import {
  ChevronDownIcon,
  FolderCloseIcon,
  FolderOpenIcon,
  SendIcon,
} from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, commandsKey, useT } from "../../lib/app-state.ts";
import { presetDescription, presetName } from "../../lib/presets.ts";
import { DEFAULT_PRESET_ID } from "../../lib/types.ts";
import { isCoarsePointer } from "../../lib/pointer.ts";
import { PI_MARK_URL } from "../../lib/brand.ts";
import { useStore } from "../../lib/store.ts";
import { AttachmentInput, AttachmentStrip, AttachButton } from "./AttachmentStrip.tsx";
import { DraftMirror } from "./DraftMirror.tsx";
import { useReferenceDraft } from "./useReferenceDraft.ts";
import { ModelThinkingPicker } from "./ModelThinkingPicker.tsx";
import { SlashMenu } from "./SlashMenu.tsx";
import { FileMenu } from "./FileMenu.tsx";
import { useComposerState } from "./useComposerState.ts";
import { useImageDraft } from "./useImageDraft.ts";
import { useSlashCompletion } from "./useSlashCompletion.ts";
import { extensionCommandName, planCommandOf } from "./slash.ts";
import { useFileCompletion } from "./useFileCompletion.ts";
import styles from "./NewSessionHero.module.css";

/** Workspace chooser shown above the composer. */
function WorkspaceSelect() {
  const t = useT();
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
        {/* dsh swaps the glyph with the chip's state: an open folder once a
         * workspace is behind the label, a closed one while the chip is only
         * the "choose a workspace" call to action. */}
        {current ? (
          <FolderOpenIcon className={styles.selectorFolder} />
        ) : (
          <FolderCloseIcon className={styles.selectorFolder} />
        )}
        <span className={styles.selectorLabel}>
          {current ? current.title : t("hero.chooseWorkspace")}
        </span>
        <ChevronDownIcon className={styles.selectorCaret} width={12} height={12} />
      </button>

      {open ? (
        <div className={styles.menu} role="listbox">
          {state.projects.length === 0 ? (
            <p className={styles.warning}>{t("hero.noWorkspace")}</p>
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
                <FolderCloseIcon className={styles.selectorGlyph} />
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
 * Composition chooser beside the workspace.
 *
 * A preset is the arguments pi is started with — the system prompt and the tool
 * set — so it is only ever a creation-time choice: pi has no RPC to recompose a
 * running process, which is the same fact dsh spells as its preset being locked
 * once a session's conversation starts. That is why the chooser is here, on the
 * hero, and not in settings.
 */
function PresetSelect() {
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
  // nothing to switch to either: a chip that can only repeat the default would
  // read as a control that does nothing.
  if (presets.length <= 1) return null;

  const selectedId = state.newSessionPresetId ?? DEFAULT_PRESET_ID;

  return (
    <div className={styles.selector} ref={rootRef}>
      <button
        type="button"
        className={styles.selectorButton}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t("preset.choose")}
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name="sparkle" size={13} className={styles.selectorFolder} />
        <span className={styles.selectorLabel}>{presetName(t, selectedId)}</span>
        <ChevronDownIcon className={styles.selectorCaret} width={12} height={12} />
      </button>
      {open ? (
        <div className={styles.menu} role="listbox">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="option"
              aria-selected={preset.id === selectedId}
              className={clsx(
                styles.menuItem,
                preset.id === selectedId && styles.menuItemActive,
              )}
              title={presetDescription(t, preset.id)}
              onClick={() => {
                // The default is stored as null, so "not chosen" and "chose the
                // default" stay one state rather than two that behave alike.
                actions.setNewSessionPresetId(preset.id === DEFAULT_PRESET_ID ? null : preset.id);
                setOpen(false);
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

/**
 * The empty state shown when no conversation is open, modelled on dsh's hero:
 * brand mark, workspace chooser, and a large composer. The first message
 * creates the session and is delivered to it.
 *
 * The card takes pictures the same three ways the conversation's composer does
 * — pasted, dropped, or picked — because it is the same input one step earlier
 * in the session's life. The attachments ride along with the first message and
 * are delivered by `pendingPrompt` once the draft has a real session behind it
 * (see `startDraftSession`).
 *
 * The model picker sits where the conversation composer keeps it, and choosing
 * here is the point of it: the first message is the only chance to pick the
 * model the *first* turn runs on, and a session that does not exist yet has no
 * picker of its own. The list comes from the project rather than from a session
 * — pi resolves it from `models.json`, its built-in catalog and `auth.json` —
 * so no process has to exist for the choice to be offered.
 */
export function NewSessionHero() {
  const t = useT();
  const state = useStore(appStore);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The layer painting the draft under the transparent textarea. */
  const mirrorRef = useRef<HTMLDivElement>(null);

  const project = state.projects.find((candidate) => candidate.id === state.selectedProjectId);
  const reference = useReferenceDraft({
    text,
    setText,
    textareaRef,
    workspacePath: project?.path,
  });
  const draft = useImageDraft(reference);
  // pi's own default until the user picks another one; `selectModel` on this
  // path only remembers the choice, which `startDraftSession` then hands to the
  // session it creates.
  const composer = useComposerState({
    sessionPath: null,
    projectId: state.selectedProjectId,
  });
  // The hero opens a *new* session, while every built-in command acts on an
  // existing one (/compact, /export, /session, /name), so offering them here
  // would just be a menu of things that cannot work yet. The rest of the menu
  // follows the composition the user picked next door: choosing minimal has to
  // drop the skills and templates that composition does not load, or the menu
  // would promise a first message's command that the session cannot run.
  const heroPresetId = state.newSessionPresetId ?? DEFAULT_PRESET_ID;
  const commands = (
    state.selectedProjectId
      ? (state.commands[commandsKey(state.selectedProjectId, heroPresetId)] ?? [])
      : []
  ).filter((command) => command.source !== "builtin");
  const completion = useSlashCompletion({ setText, textareaRef, commands });
  /** The `@` menu, searching the project the first message will be sent in. */
  const fileCompletion = useFileCompletion({
    textareaRef,
    projectId: state.selectedProjectId,
    insertReference: reference.insertReference,
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Fetch the picked composition's commands, so the `/` menu describes the
  // session the first message will actually create.
  useEffect(() => {
    if (state.selectedProjectId !== null) {
      void actions.loadCommands(state.selectedProjectId, heroPresetId);
    }
  }, [state.selectedProjectId, heroPresetId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const submit = (): void => {
    const message = text.trim();
    const attachments = draft.images;
    // A picture alone is a complete first message, the same as it is in the
    // conversation composer.
    if ((message.length === 0 && attachments.length === 0) || !project) return;
    setText("");
    draft.clear();
    // The same rule as the conversation composer's `submit`: a send ends the
    // token the menu was built from, and clearing the draft is a write the menu
    // cannot hear. This path happens to unmount the hero a moment later, but the
    // rule belongs to the send rather than to that accident.
    completion.close();
    // The labels go with the draft: this message is already made, and nothing
    // can put it back into this card.
    const outgoing = reference.expand(message);
    reference.clear();
    // A first message can be an extension command — `/plan` is the one that
    // matters, and the menu next door offers it — and pi consumes those without
    // recording a user turn. The handoff has to say so, or the conversation that
    // mounts for the new session would draw the typed line as a message nothing
    // ever wrote.
    const command = planCommandOf(outgoing) !== null || extensionCommandName(outgoing, commands) !== null;
    // Creates the draft immediately and queues the message for the session
    // that replaces it once pi is ready. Only a model the user actually chose
    // is passed on: null means "start on pi's default", which is not the same
    // request as naming the model pi would have picked anyway.
    actions.startDraftSession(
      project.id,
      outgoing,
      attachments,
      state.newSessionModel,
      state.newSessionThinkingLevel,
      state.newSessionPresetId,
      command,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While a completion menu is open it owns the arrow keys, Enter/Tab and
    // Escape, so Enter completes a candidate instead of starting a session.
    if (completion.onKeyDown(event)) return;
    if (fileCompletion.onKeyDown(event)) return;

    // A reference is one thing to the caret, not a run of characters: one
    // keystroke takes the whole chip (see `referenceAtCaret`).
    if (
      !event.nativeEvent.isComposing &&
      (event.key === "Backspace" || event.key === "Delete") &&
      reference.removeAtCaret(event.key)
    ) {
      event.preventDefault();
      completion.sync();
      fileCompletion.sync();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      // The same rule the conversation composer draws: on a coarse pointer the
      // Return key is the only newline there is, so it inserts one and the send
      // disc is what starts the session.
      if (isCoarsePointer()) return;
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.hero}>
      <div className={styles.inner}>
        <div className={styles.titleRow}>
          <img className={styles.mark} src={PI_MARK_URL} alt="" draggable={false} />
          <h1 className={styles.title}>{t("hero.title")}</h1>
          <span className={styles.badge}>{t("hero.badge")}</span>
        </div>

        <div className={styles.selectors}>
          <WorkspaceSelect />
          <PresetSelect />
        </div>

        <div
          className={styles.composer}
          data-dragging={draft.dragging || undefined}
          {...draft.dragProps}
        >
          {completion.open ? (
            <SlashMenu
              matches={completion.matches}
              highlight={completion.highlight}
              onHighlight={completion.setHighlight}
              onSelect={completion.select}
            />
          ) : fileCompletion.open ? (
            <FileMenu
              matches={fileCompletion.matches}
              loading={fileCompletion.loading}
              error={fileCompletion.error}
              indexed={fileCompletion.indexed}
              highlight={fileCompletion.highlight}
              onHighlight={fileCompletion.setHighlight}
              onSelect={fileCompletion.select}
            />
          ) : null}

          <AttachmentStrip
            images={draft.images}
            refusal={draft.refusal}
            onRemove={draft.remove}
          />

          <div className={styles.inputStack}>
            <DraftMirror text={text} commands={commands} className={styles.inputMirror} mirrorRef={mirrorRef} />
            <textarea
              ref={textareaRef}
              className={styles.input}
              value={text}
              rows={2}
              spellCheck={false}
              disabled={!project}
              placeholder={project ? t("hero.placeholder") : t("sidebar.newSessionNoProject")}
              aria-label={t("hero.firstMessageLabel")}
              onChange={(event) => {
                setText(event.target.value);
                completion.sync();
                fileCompletion.sync();
              }}
              onKeyUp={() => {
                completion.sync();
                fileCompletion.sync();
              }}
              onClick={() => {
                completion.sync();
                fileCompletion.sync();
              }}
              onKeyDown={onKeyDown}
              onPaste={draft.onPaste}
              onScroll={(event) => {
                const mirror = mirrorRef.current;
                if (mirror) mirror.scrollTop = event.currentTarget.scrollTop;
              }}
            />
          </div>
          <div className={styles.toolbar}>
            <AttachButton disabled={!project} onClick={draft.openPicker} />
            <AttachmentInput
              inputRef={draft.fileInputRef}
              onFiles={(files) => void draft.attach(files)}
            />
            <span className={styles.toolbarHint}>
              {t(isCoarsePointer() ? "hero.keyboardHintTouch" : "hero.keyboardHint")}
            </span>
            {project ? (
              <ModelThinkingPicker
                model={composer.state?.model ?? null}
                models={composer.state?.models ?? null}
                level={composer.state?.thinkingLevel ?? null}
                levels={composer.state?.model?.thinkingLevels ?? null}
                loading={composer.modelsLoading}
                onRequest={() => void composer.ensureLive()}
                onSelectModel={(provider, id) => void composer.selectModel(provider, id)}
                onSelectThinking={(level) => void composer.selectThinking(level)}
              />
            ) : null}
            <button
              type="button"
              className={styles.send}
              disabled={
                !project || (text.trim().length === 0 && draft.images.length === 0)
              }
              aria-label={t("hero.start")}
              title={t("hero.start")}
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
