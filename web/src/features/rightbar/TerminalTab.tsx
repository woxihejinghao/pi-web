import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/api.ts";
import { useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { rightbarActions, type RightbarTab } from "./rightbar-state.ts";
import {
  attachShell,
  shellName,
  subscribeTerminalOutput,
  terminalActions,
  terminalStore,
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
 * out of the stylesheet and handed over as a plain string. One consequence
 * worth stating — a theme change does not reach a running terminal, because
 * xterm would have to repaint a screen that is mid-command to apply it. The tab
 * is remounted on the next mount, which is also when the appearance is stable.
 */
function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
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
    getComputedStyle(document.documentElement),
    "--dsw-font-mono",
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  );
}

type Phase =
  | { kind: "starting" }
  | { kind: "ready"; id: string }
  | { kind: "failed"; message: string };

/**
 * One shell, drawn by xterm.js.
 *
 * The body owns the drawing half of the lifecycle: it builds the screen,
 * replays what it missed, streams keystrokes back and reports its own size. The
 * conversation with the host — attach, or open one if that id is gone — belongs
 * to `attachShell` in `terminal-state.ts`.
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
  const state = useStore(terminalStore);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [restartCount, setRestartCount] = useState(0);

  const shellId = phase.kind === "ready" ? phase.id : null;
  const shell =
    shellId === null
      ? null
      : (terminalsFor(state, sessionPath).find((item) => item.id === shellId) ?? null);
  const exitCode = shell?.exitCode ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let cancelled = false;
    let shellId: string | null = null;
    let unsubscribeOutput: (() => void) | null = null;
    let disposeInput: { dispose(): void } | null = null;
    let observer: ResizeObserver | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontFamily(),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Measuring before the pane has a size throws inside the addon; the
    // ResizeObserver below fits again as soon as there is one.
    try {
      fit.fit();
    } catch {
      // The pane is not laid out yet.
    }

    const start = async (): Promise<void> => {
      try {
        const attached = await attachShell({
          sessionPath,
          projectPath,
          // Read once, at mount. `target` is written back below, and depending
          // on it would tear the terminal down and build it again the moment it
          // stopped being empty.
          knownId: tab.target,
          cols: term.cols,
          rows: term.rows,
          // Also read once: changing it later is what the restart path is for,
          // and a picker that could re-point a *running* shell would be lying
          // about what that process is.
          shell: tab.shell ?? "",
        });
        if (cancelled) return;

        shellId = attached.info.id;
        setPhase({ kind: "ready", id: attached.info.id });
        if (attached.info.id !== tab.target) {
          rightbarActions.setTabTarget(tabKey, tab.id, attached.info.id);
        }
        // Name the tab after the program that actually started. That is the
        // only moment this can be known: "no preference" resolves to the login
        // shell on the host, and a stale path resolves to a fallback. Done only
        // while the title is still empty so a rename is never overwritten.
        if (tab.title.length === 0 && attached.info.shell.length > 0) {
          rightbarActions.setTabTitle(tabKey, tab.id, shellName(attached.info.shell));
        }

        // Replay first, subscribe second. The scrollback is everything up to
        // the moment the server answered, so subscribing first would draw that
        // same stretch a second time. What falls in the gap between the two —
        // one round trip, on loopback — is the price, and a shell redraws its
        // prompt far more often than it prints something that must not be lost.
        if (attached.scrollback.length > 0) term.write(attached.scrollback);
        unsubscribeOutput = subscribeTerminalOutput(attached.info.id, (data) => {
          term.write(data);
        });

        disposeInput = term.onData((data) => {
          const id = shellId;
          if (id === null) return;
          void api.writeTerminal(id, data).catch(() => {
            // A keystroke that raced the shell's exit. The exit notice is
            // already on its way from the stream.
          });
        });

        observer = new ResizeObserver(() => {
          const id = shellId;
          if (id === null) return;
          const before = `${String(term.cols)}x${String(term.rows)}`;
          try {
            fit.fit();
          } catch {
            return;
          }
          if (`${String(term.cols)}x${String(term.rows)}` === before) return;
          // Only a real change is sent: a drag produces a frame per pixel, and
          // the shell neither needs nor can use most of them.
          void api.resizeTerminal(id, term.cols, term.rows).catch(() => {});
        });
        observer.observe(container);
      } catch (err) {
        if (!cancelled) setPhase({ kind: "failed", message: (err as Error).message });
      }
    };

    void start();

    return () => {
      cancelled = true;
      observer?.disconnect();
      disposeInput?.dispose();
      unsubscribeOutput?.();
      // Detaching, not killing: the PTY is the host's, and it outlives a tab.
      term.dispose();
    };
    // `tab.target` is deliberately absent — see the comment inside.
  }, [tab.id, tabKey, sessionPath, projectPath, restartCount]);

  const restart = (): void => {
    // Retire the old shell rather than only forgetting it. It has exited, but it
    // still holds one of the host's slots, and the next mount opens a new one —
    // restoring a few times would otherwise fill the cap with shells nobody can
    // reach. Clearing `target` is what makes that next mount open instead of
    // reattach.
    if (tab.target.length > 0) terminalActions.release(tab.target);
    rightbarActions.setTabTarget(tabKey, tab.id, "");
    setPhase({ kind: "starting" });
    setRestartCount((count) => count + 1);
  };

  return (
    <div className={styles.host}>
      <div className={styles.screen} ref={containerRef} />
      {phase.kind === "starting" ? (
        <div className={styles.overlay}>
          <span className={styles.spinner} aria-hidden />
          {t("terminal.starting")}
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <div className={styles.overlay}>
          <div className={pane.error}>{phase.message}</div>
        </div>
      ) : null}
      {exitCode !== null ? (
        <div className={styles.exited}>
          <span>{t("terminal.exited", { code: String(exitCode) })}</span>
          <button type="button" className={styles.restart} onClick={restart}>
            {t("terminal.restart")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
