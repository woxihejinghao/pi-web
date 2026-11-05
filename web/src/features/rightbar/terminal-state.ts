import { api } from "../../lib/api.ts";
import { createStore, type Store } from "../../lib/store.ts";
import type {
  TerminalCleanupFailure,
  TerminalEnvironment,
  TerminalInfo,
  TerminalShell,
  TerminalSnapshot,
  TerminalSupport,
} from "../../lib/types.ts";

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
 *
 * Frames carry a monotone sequence because a transport can drop one: the
 * subscriber compares it with the frame it expected and asks for a fresh screen
 * rather than appending a gap.
 */
interface TerminalFrame {
  sequence: number;
  data: string;
}

type OutputListener = (frame: TerminalFrame) => void;

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

export function emitTerminalOutput(id: string, frame: TerminalFrame): void {
  const listeners = outputListeners.get(id);
  if (listeners === undefined) return;
  // A listener that throws (a disposed xterm, mid-teardown) must not stop the
  // others — there is only ever one here today, but the cost of the copy is
  // nothing next to a lost frame.
  for (const listener of [...listeners]) {
    try {
      listener(frame);
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
  environment: TerminalEnvironment | null;
  /** Installed shells, discovered once and shared by every picker. */
  shells: TerminalShell[];
  defaultShell: TerminalShell | null;
  /** Closes whose process is still alive; worth showing, since they leak. */
  cleanup: TerminalCleanupFailure[];
  /** Live and finished shells, by session path. */
  bySession: Record<string, TerminalInfo[]>;
}

const EMPTY: TerminalState = {
  support: null,
  environment: null,
  shells: [],
  defaultShell: null,
  cleanup: [],
  bySession: {},
};

export const terminalStore: Store<TerminalState> = createStore({ ...EMPTY });

/** Test seam: drop every session's list, and the memo of who is listening. */
export function resetTerminalState(): void {
  terminalStore.set({ ...EMPTY });
  outputListeners.clear();
}

function upsert(
  bySession: Record<string, TerminalInfo[]>,
  info: TerminalInfo,
): Record<string, TerminalInfo[]> {
  const existing = bySession[info.sessionPath] ?? [];
  const index = existing.findIndex((item) => item.id === info.id);
  const next = index === -1 ? [...existing, info] : existing.map((item, at) => (at === index ? info : item));
  return { ...bySession, [info.sessionPath]: next };
}

export const terminalActions = {
  /** Ask about the host and about one session's shells, in one round trip. */
  async refresh(
    sessionPath: string,
  ): Promise<{
    support: TerminalSupport;
    environment: TerminalEnvironment;
    terminals: TerminalInfo[];
  }> {
    const answer = await api.terminalState(sessionPath);
    terminalStore.update((state) => ({
      ...state,
      support: answer.support,
      environment: answer.environment,
      bySession: { ...state.bySession, [sessionPath]: answer.terminals },
    }));
    return answer;
  },

  /**
   * Ask the host only, leaving every session's list alone.
   *
   * The "+" menu and the empty-pane guide need this to decide whether to offer
   * the terminal entry before any terminal exists.
   */
  async probe(): Promise<void> {
    const answer = await api.terminalState("");
    terminalStore.update((state) => ({
      ...state,
      support: answer.support,
      environment: answer.environment,
    }));
  },

  /** Installed shells, loaded once unless a caller asks to reload. */
  async loadShells(force = false): Promise<{ shells: TerminalShell[]; default: TerminalShell | null }> {
    const state = terminalStore.get();
    if (!force && state.shells.length > 0) {
      return { shells: state.shells, default: state.defaultShell };
    }
    const answer = await api.terminalShells();
    terminalStore.update((current) => ({
      ...current,
      shells: answer.shells,
      defaultShell: answer.default,
    }));
    return answer;
  },

  async refreshCleanup(): Promise<TerminalCleanupFailure[]> {
    const answer = await api.terminalCleanup();
    terminalStore.update((state) => ({ ...state, cleanup: answer.failures }));
    return answer.failures;
  },

  noteAdded(info: TerminalInfo): void {
    terminalStore.update((state) => ({ ...state, bySession: upsert(state.bySession, info) }));
  },

  /**
   * Record a state frame.
   *
   * The tab stays on screen with what it left with — an exited shell is
   * something to read, and the alternative (making it vanish) would take the
   * last thing it printed with it. An update is also how a rename or a change
   * of input controller reaches another window.
   */
  noteState(info: TerminalInfo): void {
    terminalStore.update((state) => ({ ...state, bySession: upsert(state.bySession, info) }));
  },

  /** Drop a shell that no longer exists on the host. */
  forget(id: string): void {
    terminalStore.update((state) => {
      const bySession: Record<string, TerminalInfo[]> = {};
      for (const [key, list] of Object.entries(state.bySession)) {
        bySession[key] = list.filter((info) => info.id !== id);
      }
      return { ...state, bySession };
    });
  },

  /**
   * Kill a shell and forget it.
   *
   * Called when the user is done with one — closing its tab. Every *other*
   * unmount only detaches, which is what lets a running build survive the
   * sidebar being toggled shut.
   */
  release(id: string): void {
    terminalActions.forget(id);
    void api.closeTerminal(id).catch(() => {
      // Already gone, or the server restarting. There is nothing left to close.
    });
  },

  /** Try a failed close again, and drop it from the banner when it succeeds. */
  async retryCleanup(id: string): Promise<void> {
    await api.retryTerminalCleanup(id);
    await terminalActions.refreshCleanup();
  },

  async rename(id: string, title: string): Promise<TerminalInfo> {
    const info = await api.renameTerminal(id, title);
    terminalActions.noteState(info);
    return info;
  },
};

/** One session's shells, or an empty list when it has never been asked about. */
export function terminalsFor(state: TerminalState, sessionPath: string): TerminalInfo[] {
  return state.bySession[sessionPath] ?? [];
}

/** What a shell is called on a tab, before anyone renames it. */
export function shellName(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, "");
}

/** The label for a shell: the user's title, else the program's own name. */
export function terminalTitle(info: TerminalInfo): string {
  return info.title.length > 0 ? info.title : info.shell.name;
}

export interface ShellConnection {
  info: TerminalInfo;
  /**
   * The attachment that owns input, or "" when the shell is finished.
   *
   * A finished shell is read, not written: attaching would make this page its
   * controller for no reason and hide the exit notice behind live-looking input.
   */
  attachmentId: string;
  screen: string;
  sequence: number;
}

/**
 * Attach to a shell, opening one if there is nothing to attach to.
 *
 * The tab passes the host id it remembers, which is what makes a reload
 * reattach instead of orphan: the shell that was running when the page went
 * away is still running, and its screen comes back as a serialized snapshot.
 * When the id is gone — the server restarted, or the layout came from another
 * run — `openId` is a fresh identity for the replacement, so a retry on this
 * mount reuses it instead of opening a second shell.
 */
/**
 * A tab points at a shell this host no longer has.
 *
 * The usual cause is a page reload after the server restarted: the tab's
 * layout survived, the process did not. Opening a fresh shell in its place
 * without asking would hide that the previous one is gone, so the tab says so
 * and offers a new terminal.
 */
export class TerminalGoneError extends Error {
  constructor() {
    super("terminal process is gone");
    this.name = "TerminalGoneError";
  }
}

export async function attachShell(input: {
  sessionPath: string;
  projectPath: string;
  knownId: string;
  openId: string;
  shellPath?: string;
  cols: number;
  rows: number;
  attachmentId: string;
  /**
   * Called as soon as the host id is known, before the screen arrives.
   *
   * The tab subscribes here rather than after `attachShell` resolves, so output
   * published while the snapshot is being serialized is buffered and applied on
   * top of it instead of falling into the gap between two requests.
   */
  onId?: (id: string) => void;
}): Promise<ShellConnection> {
  const answer = await terminalActions.refresh(input.sessionPath);
  const known = answer.terminals.find((item) => item.id === input.knownId);

  if (known !== undefined) {
    terminalActions.noteState(known);
    input.onId?.(known.id);
    if (known.state === "running") {
      const snapshot = await api.attachTerminal(known.id, input.attachmentId);
      terminalActions.noteState(snapshot.info);
      return {
        info: snapshot.info,
        attachmentId: input.attachmentId,
        screen: snapshot.screen,
        sequence: snapshot.sequence,
      };
    }
    const snapshot = await api.terminalSnapshot(known.id);
    terminalActions.noteState(snapshot.info);
    return {
      info: snapshot.info,
      attachmentId: "",
      screen: snapshot.screen,
      sequence: snapshot.sequence,
    };
  }

  // The tab remembers a host identity, and this host no longer has it. Never
  // silently mint a replacement: the screen the user expects is gone.
  if (input.knownId.length > 0) throw new TerminalGoneError();

  // Only asked when a shell is about to be opened: the reason belongs next to
  // the thing that cannot happen, not on a page that never wanted a terminal.
  // `node-pty` is an optional dependency, so this is a reachable state on a
  // machine with no prebuilt binary for its platform.
  if (!answer.support.available) {
    throw new Error(answer.support.reason ?? "terminal unavailable");
  }

  const info = await api.openTerminal({
    id: input.openId,
    sessionPath: input.sessionPath,
    cwd: input.projectPath,
    cols: input.cols,
    rows: input.rows,
    ...(input.shellPath === undefined ? {} : { shellPath: input.shellPath }),
  });
  terminalActions.noteAdded(info);
  input.onId?.(info.id);
  const snapshot = await api.attachTerminal(info.id, input.attachmentId);
  terminalActions.noteState(snapshot.info);
  return {
    info: snapshot.info,
    attachmentId: input.attachmentId,
    screen: snapshot.screen,
    sequence: snapshot.sequence,
  };
}

/** Take input control back from another window, and answer with a fresh screen. */
export async function takeControl(id: string, attachmentId: string): Promise<TerminalSnapshot> {
  const snapshot = await api.attachTerminal(id, attachmentId);
  terminalActions.noteState(snapshot.info);
  return snapshot;
}

/** Repair a dropped frame: the latest screen, without changing who controls it. */
export async function resyncTerminal(id: string): Promise<TerminalSnapshot> {
  const snapshot = await api.terminalSnapshot(id);
  terminalActions.noteState(snapshot.info);
  return snapshot;
}
