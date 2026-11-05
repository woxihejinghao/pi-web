import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/api.ts";
import { useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { TerminalInfo } from "../../lib/types.ts";
import { rightbarActions, type RightbarTab } from "./rightbar-state.ts";
import {
  attachShell,
  resyncTerminal,
  TerminalGoneError,
  subscribeTerminalOutput,
  takeControl,
  terminalActions,
  terminalStore,
  terminalTitle,
  terminalsFor,
} from "./terminal-state.ts";
import pane from "./Pane.module.css";
import styles from "./TerminalTab.module.css";

/**
 * The sixteen ANSI colors, which the design tokens have no opinion about.
 *
 * Surfaces (background, cursor, selection) come from the token sheet so the
 * terminal reads as a column of the page rather than a dark card sitting on it.
 * "Bright yellow" has no such equivalent, so it is a fixed pair of palettes
 * borrowed from a scheme that was designed for both.
 */
const ANSI_LIGHT = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#57606a",
  brightBlack: "#6e7781",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
} as const;

const ANSI_DARK = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
} as const;

function readToken(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * The colors xterm paints with.
 *
 * xterm draws to a canvas, so it cannot inherit CSS: every value has to be read
 * out of the stylesheet and handed over as a plain string. The appearance is
 * re-read whenever the document's theme attribute changes, so a running shell
 * follows the user's choice instead of staying in the theme it was mounted in.
 */
function terminalTheme(): ITheme {
  // The token sheet is painted on `body`, not on `:root` — reading it off
  // `documentElement` returned empty strings, which silently fell back to the
  // hard-coded pair below and left a light-theme terminal with a black
  // background (xterm.css paints `.xterm-viewport` black of its own accord).
  const style = getComputedStyle(document.body);
  const dark = document.documentElement.dataset.appearance === "dark";
  return {
    background: readToken(style, "--dsw-alias-bg-base", dark ? "#191919" : "#ffffff"),
    foreground: readToken(style, "--dsw-alias-label-primary", dark ? "#e6e6e6" : "#1f1f1f"),
    cursor: readToken(style, "--dsw-alias-label-primary", dark ? "#e6e6e6" : "#1f1f1f"),
    selectionBackground: readToken(style, "--dsw-alias-bg-multi-select", "rgba(64,128,255,0.3)"),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

function terminalFontFamily(): string {
  return readToken(
    getComputedStyle(document.body),
    "--dsw-font-mono",
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  );
}

type Phase =
  | { kind: "starting" }
  | { kind: "ready"; id: string; info: TerminalInfo }
  | { kind: "failed"; message: string; unavailable?: boolean; gone?: boolean };

const HEARTBEAT_MS = 30_000;

/**
 * One shell, drawn by xterm.js.
 *
 * The body owns the drawing half of the lifecycle: it builds the screen,
 * applies the serialized snapshot the host answers with, buffers frames that
 * arrive while that snapshot is in flight, streams keystrokes back and reports
 * its own size. The conversation with the host — attach, or open one if that id
 * is gone — belongs to `attachShell` in `terminal-state.ts`.
 *
 * The panel above it only decides whether the tab is on screen: unmounting one
 * detaches, it does not kill, because a build the user started must survive
 * toggling the sidebar.
 */
export function TerminalTab({
  sessionPath,
  projectPath,
  tabKey,
  tab,
}: {
  sessionPath: string;
  projectPath: string;
  tabKey: string;
  tab: RightbarTab;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const attachmentRef = useRef("");
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [restartCount, setRestartCount] = useState(0);
  const state = useStore(terminalStore);

  const shellId = phase.kind === "ready" ? phase.id : null;
  const fallback = phase.kind === "ready" ? phase.info : null;
  const info =
    shellId === null
      ? null
      : (terminalsFor(state, sessionPath).find((item) => item.id === shellId) ?? fallback);
  const writable =
    info !== null && info.state === "running" && info.controllerId === attachmentRef.current;
  const readOnly = info !== null && info.state === "running" && !writable;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const attachmentId = crypto.randomUUID();
    attachmentRef.current = attachmentId;
    let cancelled = false;
    let terminalId: string | null = null;
    let current: TerminalInfo | null = null;
    let expected: number | null = null;
    let buffered: Array<{ sequence: number; data: string }> = [];
    let unsubscribeOutput: (() => void) | null = null;
    let disposeInput: { dispose(): void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let resyncing = false;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // Measuring before the pane has a size throws inside the addon; the
      // ResizeObserver below fits again as soon as there is one.
    }

    const paint = (screen: string, info: TerminalInfo): void => {
      term.reset();
      try {
        term.resize(info.cols, info.rows);
      } catch {
        // A screen that refuses its own dimensions is still readable.
      }
      if (screen.length > 0) term.write(screen);
    };

    const repair = async (): Promise<void> => {
      if (resyncing || cancelled || terminalId === null) return;
      resyncing = true;
      try {
        const snapshot = await resyncTerminal(terminalId);
        if (cancelled) return;
        expected = Math.max(expected ?? 0, snapshot.sequence);
        paint(snapshot.screen, snapshot.info);
      } catch {
        // The stream will try again on the next frame; a failed repair must not
        // take down a terminal that is otherwise still printing.
      } finally {
        resyncing = false;
      }
    };

    const apply = (frame: { sequence: number; data: string }): void => {
      if (expected === null) {
        buffered.push(frame);
        return;
      }
      if (frame.sequence <= expected) return;
      if (frame.sequence !== expected + 1) {
        void repair();
        return;
      }
      expected = frame.sequence;
      term.write(frame.data);
    };

    const sendInput = (data: string): void => {
      if (terminalId === null) return;
      const id = terminalId;
      void api
        .writeTerminal(id, attachmentId, data)
        .catch((err: unknown) => {
          // 409 means another window took control; asking its own state again
          // turns the keyboard off without guessing which window it was.
          if (err instanceof Error && /接管|control/i.test(err.message)) {
            void terminalActions.refresh(sessionPath).catch(() => {});
          }
        });
    };

    const start = async (): Promise<void> => {
      try {
        const connected = await attachShell({
          sessionPath,
          projectPath,
          // Read once, at mount. `target` is written back below, and depending
          // on it would tear the terminal down and build it again the moment it
          // stopped being empty.
          knownId: tab.target,
          openId: crypto.randomUUID(),
          cols: term.cols > 1 ? term.cols : 80,
          rows: term.rows > 1 ? term.rows : 24,
          attachmentId,
          ...(tab.shellPath === undefined ? {} : { shellPath: tab.shellPath }),
          onId: (id) => {
            terminalId = id;
            // Subscribe before the snapshot so output published while it is
            // being serialized is buffered rather than lost.
            unsubscribeOutput = subscribeTerminalOutput(id, apply);
          },
        });
        if (cancelled) return;

        terminalId = connected.info.id;
        current = connected.info;
        expected = connected.sequence;
        paint(connected.screen, connected.info);
        for (const frame of buffered) apply(frame);
        buffered = [];

        const environment = terminalStore.get().environment;
        if (environment !== null) term.options.scrollback = environment.scrollback;
        term.options.disableStdin = connected.info.controllerId !== attachmentId;

        setPhase({ kind: "ready", id: connected.info.id, info: connected.info });
        if (connected.info.id !== tab.target) {
          rightbarActions.setTabTarget(tabKey, tab.id, connected.info.id);
        }
        // Name the tab after the shell. Done only while the title is still
        // empty so a rename is never overwritten.
        if (tab.title.length === 0) {
          rightbarActions.setTabTitle(tabKey, tab.id, terminalTitle(connected.info));
        }
        if (connected.info.controllerId === attachmentId) term.focus();

        disposeInput = term.onData(sendInput);

        resizeObserver = new ResizeObserver(() => {
          const before = `${String(term.cols)}x${String(term.rows)}`;
          try {
            fit.fit();
          } catch {
            return;
          }
          if (`${String(term.cols)}x${String(term.rows)}` === before) return;
          if (terminalId === null || current?.controllerId !== attachmentId) return;
          const bounds = terminalStore.get().environment;
          const cols = bounds === null ? term.cols : Math.min(term.cols, bounds.maxCols);
          const rows = bounds === null ? term.rows : Math.min(term.rows, bounds.maxRows);
          void api.resizeTerminal(terminalId, attachmentId, cols, rows).catch(() => {});
        });
        resizeObserver.observe(container);
      } catch (err) {
        if (!cancelled) {
          const message = (err as Error).message;
          setPhase({
            kind: "failed",
            message,
            unavailable: /node-pty|unavailable|不可用|未安装/i.test(message),
          });
        }
      }
    };

    // The appearance can change while a shell is running; xterm cannot inherit
    // CSS, so the palette has to be handed to it again.
    themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-appearance", "class", "style"],
    });

    void start();

    return () => {
      cancelled = true;
      themeObserver?.disconnect();
      resizeObserver?.disconnect();
      disposeInput?.dispose();
      unsubscribeOutput?.();
      // Detaching, not killing: the PTY is the host's, and it outlives a tab.
      if (terminalId !== null) detach(terminalId, attachmentId);
      term.dispose();
      termRef.current = null;
    };
    // `tab.target` is deliberately absent — see the comment inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tabKey, sessionPath, projectPath, restartCount]);

  // A keyboard that is not allowed to write must not pretend otherwise: xterm
  // still receives the keystroke and would show the caret moving.
  useEffect(() => {
    if (termRef.current !== null) termRef.current.options.disableStdin = !writable;
  }, [writable, phase.kind]);

  // Keep the page counted as alive so its attachment is not reaped while the
  // user is reading a long build.
  useEffect(() => {
    if (!writable || shellId === null) return;
    const timer = setInterval(() => {
      void api.heartbeatTerminal(shellId, attachmentRef.current).catch(() => {});
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
    };
  }, [writable, shellId]);

  // Another window's rename (or this one's) arrives as a state frame; the tab
  // strip must follow it, since that is where the name is drawn.
  const title = info === null ? "" : terminalTitle(info);
  useEffect(() => {
    if (title.length === 0 || title === tab.title) return;
    rightbarActions.setTabTitle(tabKey, tab.id, title);
  }, [title, tab.title, tab.id, tabKey]);

  const takeOver = async (): Promise<void> => {
    if (shellId === null) return;
    try {
      const snapshot = await takeControl(shellId, attachmentRef.current);
      const term = termRef.current;
      if (term !== null) {
        term.reset();
        try {
          term.resize(snapshot.info.cols, snapshot.info.rows);
        } catch {
          // Readable anyway.
        }
        term.write(snapshot.screen);
        term.focus();
      }
    } catch {
      // Another window may have closed it in the meantime; its state frame is
      // already on the way.
    }
  };

  const replaceShell = (): void => {
    // Retire the old shell rather than only forgetting it. It still holds one
    // of the host's slots, and slots are capped; replacing a few times would
    // otherwise fill the cap with shells nobody can reach. Clearing `target` is
    // what makes the next mount open instead of reattach.
    if (info !== null && info.state !== "running") terminalActions.release(info.id);
    rightbarActions.setTabTarget(tabKey, tab.id, "");
    setPhase({ kind: "starting" });
    setRestartCount((count) => count + 1);
  };

  return (
    <div className={styles.host}>
      <div className={styles.screen} ref={containerRef} aria-label={t("terminal.screen")} />
      {phase.kind === "starting" ? (
        <div className={styles.overlay}>
          <span className={styles.spinner} aria-hidden />
          {t("terminal.starting")}
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <div className={styles.overlay}>
          <div className={pane.error}>{phase.message}</div>
          {phase.gone === true ? (
            <button type="button" className={styles.action} onClick={replaceShell}>
              {t("terminal.newTerminal")}
            </button>
          ) : phase.unavailable !== true ? (
            <button type="button" className={styles.action} onClick={replaceShell}>
              {t("terminal.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
      {readOnly && info !== null ? (
        <div className={styles.notice}>
          <span>{t("terminal.readOnly")}</span>
          <button type="button" className={styles.action} onClick={() => void takeOver()}>
            {t("terminal.takeControl")}
          </button>
        </div>
      ) : null}
      {info !== null && info.state === "exited" ? (
        <div className={styles.notice}>
          <span>{t("terminal.exited", { code: String(info.exitCode ?? 0) })}</span>
          <button type="button" className={styles.action} onClick={replaceShell}>
            {t("terminal.newTerminal")}
          </button>
        </div>
      ) : null}
      {info !== null && info.state === "failed" ? (
        <div className={styles.notice}>
          <span className={styles.error}>{info.error ?? t("terminal.failed")}</span>
          <button type="button" className={styles.action} onClick={replaceShell}>
            {t("terminal.newTerminal")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tell the host this page is going away.
 *
 * `sendBeacon` rather than `fetch`: a tab that is closed or navigated away from
 * cancels an in-flight request, and the detachment is exactly the message that
 * would be lost. The server ignores an id it no longer knows.
 */
function detach(id: string, attachmentId: string): void {
  const url = `/api/terminal/${encodeURIComponent(id)}/detach`;
  const body = JSON.stringify({ attachmentId });
  if (typeof navigator.sendBeacon === "function") {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(url, blob)) return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Best effort: the attachment reaper is the backstop.
  });
}
