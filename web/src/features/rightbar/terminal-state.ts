import { api } from "../../lib/api.ts";
import { createStore, type Store } from "../../lib/store.ts";
import type { TerminalInfo, TerminalSupport } from "../../lib/types.ts";

/**
 * Shell output never travels through React state.
 *
 * A shell answering a keystroke produces a handful of bytes; one running a
 * build, or `yes`, produces megabytes. Holding that in a store would re-render
 * the panel on every frame to produce content that exactly one xterm can draw,
 * so frames are fanned out here instead and written straight into whichever
 * terminal subscribed to that id. Everything *else* about a terminal — whether
 * this host has shells at all, which are open, which have exited — happens a
 * few times per session and lives in the store below.
 */
type OutputListener = (data: string) => void;

const outputListeners = new Map<string, Set<OutputListener>>();

/**
 * Watch one shell's output.
 *
 * Returns an unsubscribe that also drops the empty set, so a closed tab leaves
 * nothing behind: output for an id nobody listens to is discarded at the
 * emitter rather than queued, which is what makes unmounting a tab free.
 */
export function subscribeTerminalOutput(id: string, listener: OutputListener): () => void {
  const listeners = outputListeners.get(id) ?? new Set<OutputListener>();
  listeners.add(listener);
  outputListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) outputListeners.delete(id);
  };
}

export function emitTerminalOutput(id: string, data: string): void {
  const listeners = outputListeners.get(id);
  if (listeners === undefined) return;
  // A listener that throws (a disposed xterm, mid-teardown) must not stop the
  // others — there is only ever one here today, but the cost of the copy is
  // nothing next to a lost frame.
  for (const listener of [...listeners]) {
    try {
      listener(data);
    } catch {
      // Dropped on purpose: the tab is going away.
    }
  }
}

export interface TerminalState {
  /**
   * null until the host has been asked.
   *
   * The answer is a property of the host, not of a session, so one probe serves
   * every session in the window.
   */
  support: TerminalSupport | null;
  /** Live and finished shells, by session path. */
  bySession: Record<string, TerminalInfo[]>;
}

export const terminalStore: Store<TerminalState> = createStore({
  support: null,
  bySession: {},
});

/** Test seam: drop every session's list, and the memo of who is listening. */
export function resetTerminalState(): void {
  terminalStore.set({ support: null, bySession: {} });
  outputListeners.clear();
}

function rewrite(
  bySession: Record<string, TerminalInfo[]>,
  fn: (info: TerminalInfo) => TerminalInfo | null,
): Record<string, TerminalInfo[]> {
  const next: Record<string, TerminalInfo[]> = {};
  for (const [key, list] of Object.entries(bySession)) {
    next[key] = list.map(fn).filter((info): info is TerminalInfo => info !== null);
  }
  return next;
}

export const terminalActions = {
  /** Ask about the host and about one session's shells, in one round trip. */
  async refresh(
    sessionPath: string,
  ): Promise<{ support: TerminalSupport; terminals: TerminalInfo[] }> {
    const answer = await api.terminalState(sessionPath);
    terminalStore.update((state) => ({
      support: answer.support,
      bySession: { ...state.bySession, [sessionPath]: answer.terminals },
    }));
    return answer;
  },

  /**
   * Ask the host only, leaving every session's list alone.
   *
   * The "+" menu needs this to decide whether to offer the terminal entry
   * before any terminal exists. The tab itself does not: it starts from its own
   * `refresh`, which answers both questions at once.
   */
  async probe(): Promise<void> {
    const answer = await api.terminalState("");
    terminalStore.update((state) => ({ ...state, support: answer.support }));
  },

  noteAdded(info: TerminalInfo): void {
    terminalStore.update((state) => {
      const existing = state.bySession[info.sessionPath] ?? [];
      if (existing.some((item) => item.id === info.id)) return state;
      return {
        ...state,
        bySession: { ...state.bySession, [info.sessionPath]: [...existing, info] },
      };
    });
  },

  /**
   * Record a shell's exit.
   *
   * The tab stays on screen with the code it left with — an exited shell is
   * something to read, and the alternative (making it vanish) would take the
   * last thing it printed with it.
   */
  noteExit(id: string, exitCode: number): void {
    terminalStore.update((state) => ({
      ...state,
      bySession: rewrite(state.bySession, (info) =>
        info.id === id ? { ...info, exitCode } : info,
      ),
    }));
  },

  /** Drop a shell that no longer exists on the host. */
  forget(id: string): void {
    terminalStore.update((state) => ({
      ...state,
      bySession: rewrite(state.bySession, (info) => (info.id === id ? null : info)),
    }));
  },

  /**
   * Kill a shell and forget it.
   *
   * Called when the user is done with one — closing its tab, or restarting a
   * shell that has exited. Both have to reach the host: an exited shell keeps
   * its slot, and slots are capped, so eight restarts would leave the session
   * unable to open another one. Every *other* unmount only detaches, which is
   * what lets a running build survive the sidebar being toggled shut.
   */
  release(id: string): void {
    terminalActions.forget(id);
    void api.closeTerminal(id).catch(() => {
      // Already gone: it exited and something else reaped it, or the server was
      // restarted. Either way there is nothing left to close.
    });
  },
};

/** One session's shells, or an empty list when it has never been asked about. */
export function terminalsFor(state: TerminalState, sessionPath: string): TerminalInfo[] {
  return state.bySession[sessionPath] ?? [];
}

/**
 * What a shell is called on a tab.
 *
 * The host reports a path — `/bin/zsh`, `C:\Program Files\PowerShell\7\pwsh.exe`
 * — and a tab strip has room for the program, not the path. `.exe` is dropped
 * because Windows never says it out loud. A name with no separator is returned
 * as-is, which is also a shape `ComSpec` can take (`cmd`).
 *
 * Derived from what *started*, not from what was asked for: a request the host
 * does not list opens the fallback, and the tab has to say which one is really
 * running.
 */
export function shellName(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "");
}

/**
 * The extra shells the "+" menu lists under its Terminal entry.
 *
 * The default is left out on purpose: the entry above the list already opens
 * it, so repeating it would be two names for one action. Order is the host's,
 * which is `/etc/shells` order — the same order a login-shell manager shows.
 *
 * A host with one shell therefore yields nothing, and the menu looks exactly as
 * it did before the list existed. An unavailable host yields nothing too: the
 * entries would be dead, and the Terminal entry itself already carries the
 * reason on hover.
 */
export function shellChoices(support: TerminalSupport | null): string[] {
  if (support === null || !support.available) return [];
  return support.shells.filter((item) => item !== support.default);
}

/**
 * Attach to a shell, opening one if there is nothing to attach to.
 *
 * The tab passes the host id it remembers, which is what makes a reload
 * reattach instead of orphan: the shell that was running when the page went
 * away is still running, and its screen comes back through the scrollback read.
 * Anything else means that shell is gone — the server was restarted, or the
 * layout was written by another run — and the answer is a new shell rather than
 * an error.
 *
 * Lives here rather than in the tab because it is a conversation with the host,
 * not a drawing concern: `TerminalTab.tsx` owns xterm, this owns the protocol.
 * It is also the one place that has to know what an unavailable host means.
 */
export async function attachShell(input: {
  sessionPath: string;
  projectPath: string;
  knownId: string;
  cols: number;
  rows: number;
  /** A path from `support().shells`; empty means the login shell. */
  shell: string;
}): Promise<{ info: TerminalInfo; scrollback: string }> {
  const answer = await terminalActions.refresh(input.sessionPath);

  const known = answer.terminals.find(
    (item) => item.id === input.knownId && item.exitCode === null,
  );
  if (known !== undefined) {
    const { scrollback } = await api.terminalScrollback(known.id);
    return { info: known, scrollback };
  }

  // Only asked when a shell is about to be opened: the reason belongs next to
  // the thing that cannot happen, not on a page that never wanted a terminal.
  // `node-pty` is an optional dependency, so this is a reachable state on a
  // machine with no prebuilt binary for its platform.
  if (!answer.support.available) {
    throw new Error(answer.support.reason ?? "terminal unavailable");
  }

  const info = await api.openTerminal({
    sessionPath: input.sessionPath,
    cwd: input.projectPath,
    cols: input.cols,
    rows: input.rows,
    // Empty means "no preference", and an absent field is how that is said:
    // the host answers with the login shell, where `pickShell` would only
    // reject the empty string and fall back to the same thing.
    ...(input.shell.length > 0 ? { shell: input.shell } : {}),
  });
  terminalActions.noteAdded(info);
  return { info, scrollback: "" };
}
