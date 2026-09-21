import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { SlashCommand } from "../../lib/types.ts";
import { detectSlashTrigger, filterCommands, type SlashTrigger } from "./slash.ts";

export interface SlashCompletion {
  /** Candidates for the token under the caret. */
  matches: SlashCommand[];
  /** True when the menu should be rendered. */
  open: boolean;
  highlight: number;
  setHighlight(index: number): void;
  /** Re-read the textarea. Call on input, caret movement and blur. */
  sync(): void;
  /** Replace the `/token` under the caret with a complete command. */
  select(command: SlashCommand): void;
  /** Returns true when the key was consumed by the open menu. */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

function sameTrigger(a: SlashTrigger | null, b: SlashTrigger | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.query === b.query;
}

/**
 * `/` completion for a prompt textarea.
 *
 * The token is derived from the textarea's own value and caret rather than
 * from React state, so it stays correct through IME composition, pastes, and
 * caret moves. Callers must invoke `sync()` from `onChange`, `onKeyUp` and
 * `onClick`.
 *
 * `sync()` is a no-op when the token did not change. That matters because
 * `onKeyUp` also fires after the ArrowDown/ArrowUp this hook consumed, and
 * re-syncing there would reset the highlighted row on every keypress.
 */
export function useSlashCompletion(options: {
  setText(next: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  commands: SlashCommand[];
}): SlashCompletion {
  const { setText, textareaRef, commands } = options;
  const [trigger, setTrigger] = useState<SlashTrigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  /** Mirrors `trigger` so `sync()` can compare without re-rendering. */
  const triggerRef = useRef<SlashTrigger | null>(null);

  const matches = trigger ? filterCommands(commands, trigger.query) : [];

  const applyTrigger = useCallback((next: SlashTrigger | null): void => {
    triggerRef.current = next;
    setTrigger(next);
    setHighlight(0);
  }, []);

  const sync = useCallback((): void => {
    const element = textareaRef.current;
    if (!element) return;
    const next = detectSlashTrigger(element.value, element.selectionStart ?? 0);
    if (!sameTrigger(triggerRef.current, next)) applyTrigger(next);
  }, [applyTrigger, textareaRef]);

  const select = useCallback(
    (command: SlashCommand): void => {
      const element = textareaRef.current;
      const value = element?.value ?? "";
      const caret = element?.selectionStart ?? value.length;
      const start = triggerRef.current?.start ?? caret;
      const next = `${value.slice(0, start)}/${command.name} ${value.slice(caret)}`;

      setText(next);
      applyTrigger(null);

      // Leave the caret after the command's trailing space.
      const position = start + command.name.length + 2;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(position, position);
      });
    },
    [applyTrigger, setText, textareaRef],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!trigger || matches.length === 0) return false;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlight((current) => (current + 1) % matches.length);
          return true;
        case "ArrowUp":
          event.preventDefault();
          setHighlight((current) => (current - 1 + matches.length) % matches.length);
          return true;
        case "Enter":
        case "Tab": {
          // An active IME owns Enter; never steal it mid-composition.
          if (event.nativeEvent.isComposing) return false;
          const chosen = matches[highlight] ?? matches[0];
          if (!chosen) return false;
          event.preventDefault();
          select(chosen);
          return true;
        }
        case "Escape":
          event.preventDefault();
          applyTrigger(null);
          return true;
        default:
          return false;
      }
    },
    [applyTrigger, trigger, matches, highlight, select],
  );

  return { matches, open: trigger !== null && matches.length > 0, highlight, setHighlight, sync, select, onKeyDown };
}
