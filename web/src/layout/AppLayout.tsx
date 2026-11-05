import { useEffect, useRef } from "react";
import clsx from "clsx";
import { ConversationPane } from "../features/conversation/ConversationPane.tsx";
import { pendingUiForSession } from "../features/conversation/question-model.ts";
import { Rightbar } from "../features/rightbar/Rightbar.tsx";
import { rightbarCommands } from "../features/rightbar/shortcuts.ts";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { layoutActions, layoutStore, sidebarGeometry } from "./layout-state.ts";
import { useFrameWidth } from "./use-frame-width.ts";
import { useKeyboardInset } from "./use-keyboard-inset.ts";
import { actions, appStore, isDraftSession, useT } from "../lib/app-state.ts";
import { useShortcuts } from "../lib/shortcuts/use-shortcuts.ts";
import { setEventSession } from "../lib/sse.ts";
import { useStore } from "../lib/store.ts";
import styles from "./AppLayout.module.css";

/**
 * Three-region shell mirroring dsh's arrangement: the project/session sidebar on
 * the left, the active conversation in the middle, and the right sidebar — the
 * per-session panel the conversation header's toggle opens.
 *
 * The sidebar is the one region with two presentations. On a frame wide enough
 * to hold all three columns it is a track whose width comes from the column
 * solve (`layout/columns.ts`); below the auto-collapse breakpoint it becomes a
 * drawer over the centre, which is why the frame measures itself and writes the
 * reading to `layoutStore` rather than leaving the decision to a media query —
 * see `layout-state.ts` for why the measurement, not the window, is the input.
 */
export function AppLayout() {
  const t = useT();
  const state = useStore(appStore);
  const layout = useStore(layoutStore);
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void actions.bootstrap();
  }, []);

  // The server fans a session's token stream out only to the tab reading it;
  // this is how it learns which session that is. Fire-and-forget, and a no-op
  // until the stream greets us with its id.
  useEffect(() => {
    setEventSession(state.selectedSessionPath);
  }, [state.selectedSessionPath]);

  // Choosing a session is the end of what a narrow drawer was open for, so it
  // puts itself away. On a wide frame this is a no-op: the column there is a
  // track, and picking a row is not a reason to take it away.
  useEffect(() => {
    layoutActions.collapseNarrow();
  }, [state.selectedSessionPath]);

  // Installed here rather than inside the panel: the commands open the panel
  // too, so their owner cannot be the thing they are meant to conjure. dsh
  // makes the same division — a shortcut service on the shell, the commands
  // registered by the features that act on them.
  //
  // The settings page is why the flag exists. It renders *instead of* the shell
  // rather than over it, so this component stays mounted and the listener would
  // otherwise still be live on a page with no conversation and no panel.
  useShortcuts(rightbarCommands, !state.settingsOpen);

  // The frame measures itself only while it is on screen. The settings page
  // replaces the shell, which detaches the element the observer is watching, so
  // the measurement is gated on the shell actually being rendered — otherwise
  // returning from settings would leave the last reading (or none) in place.
  useFrameWidth(frameRef, !state.settingsOpen);

  // Published on the root element rather than kept in the store: it changes on
  // every frame of the keyboard's animation, and the CSS that consumes it is
  // the only reader.
  useKeyboardInset();

  const sidebar = sidebarGeometry(layout);

  // Whether a dialog holds the composer seat right now, asked with the pane's
  // own rule — a dialog belonging to another session is not drawn over there, so
  // it must not lift the notice either, or the notice would float up with no
  // card under it to clear.
  const selected = state.selectedSessionPath;
  const draft = isDraftSession(selected);
  const askingInComposer =
    pendingUiForSession(state.pendingUiRequests, draft ? null : selected) !== null;

  // Escape closes the drawer. It is the one dismissal a touch device also has
  // (Android's back gesture arrives as this key), so it is handled here rather
  // than only on the scrim.
  useEffect(() => {
    if (!sidebar.overlay) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") layoutActions.collapseNarrow();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebar.overlay]);

  // The settings page replaces the shell instead of sitting over it. That does
  // unmount the conversation, and remounting costs a transcript read — a few
  // milliseconds off disk, with no pi process started for it. Worth paying to
  // avoid reasoning about two live layers at once.
  if (state.settingsOpen) return <SettingsPage />;

  return (
    <div className={styles.shell} ref={frameRef}>
      {/* The drawer needs a dismissal that is not the toggle: on a phone the
          column covers most of the frame, and the conversation underneath is
          the thing the user wants back. Rendered before the column so the
          column paints over it, and `aria-hidden` because it says nothing. */}
      {sidebar.overlay ? (
        <div
          className={styles.scrim}
          aria-hidden
          onClick={() => layoutActions.collapseNarrow()}
        />
      ) : null}
      <aside
        className={clsx(
          styles.sidebar,
          sidebar.overlay && styles.sidebarOverlay,
          !sidebar.overlay && sidebar.width === 0 && styles.sidebarCollapsed,
        )}
        // A drawer takes no track: the centre keeps the room it already gave
        // away, and the column hangs over it. A track states its own width.
        style={
          sidebar.overlay
            ? undefined
            : {
                flexBasis: `${String(sidebar.width)}px`,
                width: `${String(sidebar.width)}px`,
              }
        }
      >
        <Sidebar />
      </aside>
      <main className={styles.main}>
        {state.status === "error" ? (
          <div className={styles.empty}>{t("layout.disconnected")}</div>
        ) : (
          <ConversationPane />
        )}
      </main>
      {/* Renders nothing without an open session, and a fullscreen panel takes
          itself out of this flow — so the shell stays a three-track flex row. */}
      <Rightbar />
      {state.notice ? (
        <div
          className={clsx(
            styles.notice,
            // A notify that lands while a question is waiting would otherwise sit
            // on top of the card and cover the controls the user has to reach.
            askingInComposer && styles.noticeAboveCard,
          )}
          role="status"
        >
          <span>{state.notice}</span>
          <button
            type="button"
            className={styles.noticeDismiss}
            onClick={() => actions.setNotice(null)}
            aria-label={t("layout.dismiss")}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
