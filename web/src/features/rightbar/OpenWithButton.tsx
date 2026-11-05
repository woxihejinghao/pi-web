/**
 * The preview's open control: hand this file to an application on the machine
 * running the server, or show where it is.
 *
 * dsh puts the same control in the right sidebar's document preview — a split
 * button whose main half performs the default action and whose chevron lists the
 * applications that registered for the file, with "show file location" pinned
 * behind a rule at the bottom. This is that control against this repo's host
 * protocol (see `server/src/open-with.ts` for what the host will and will not
 * answer).
 *
 * The rule for whether any of it exists is dsh's: a host with no desktop draws
 * nothing. The host reports that once per file, and `desktop: false` — an ssh
 * session, a container — removes the control rather than offering a gesture that
 * can only fail.
 *
 * The menu is portalled for the same reason the tab menu is: the panel scrolls
 * and clips, so a menu drawn inside it would be clipped with it. React's server
 * renderer refuses portals, which is why the rows live in `OpenWithMenuItems`
 * and the rules above them in `open-with.ts`, both of which the tests render
 * without a DOM.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, FolderOpenIcon } from "../../components/icons.tsx";
import { ExternalIcon } from "./rightbar-icons.tsx";
import { Tooltip } from "../../components/Tooltip.tsx";
import { api } from "../../lib/api.ts";
import type { NativeApplication } from "../../lib/types.ts";
import { useT } from "../../lib/app-state.ts";
import {
  openButtonLabel,
  openMenuRows,
  placeMenuEnd,
  rowTarget,
  type OpenMenuRow,
  type OpenTarget,
} from "./open-with.ts";
import rightbar from "./Rightbar.module.css";
import styles from "./OpenWithButton.module.css";

/**
 * The menu's rows, as markup.
 *
 * Split from the portalled shell because React's *server* renderer refuses
 * portals: this is the half with the menu itself in it — which rows, in which
 * words, behind which rules — and it is rendered by the tests directly.
 */
export function OpenWithMenuItems({
  rows,
  onPick,
}: {
  rows: readonly OpenMenuRow[];
  onPick: (id: string) => void;
}) {
  return (
    <>
      {rows.map((row) => (
        <Fragment key={row.id}>
          {row.divider ? <span className={styles.divider} role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={rightbar.menuItem}
            disabled={row.disabled}
            data-open-with-row={row.id}
            onClick={() => onPick(row.id)}
          >
            {row.id === "reveal" ? (
              <FolderOpenIcon width={14} height={14} />
            ) : row.icon === null ? (
              <span className={styles.rowIconSpacer} aria-hidden />
            ) : (
              <img className={styles.rowIcon} src={row.icon} alt="" draggable={false} />
            )}
            <span className={styles.rowLabel}>{row.label}</span>
          </button>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The control itself.
 *
 * `busy` disables it for the length of its own gesture — the host is doing
 * something the reader cannot see, and a second press would start it twice.
 */
export function OpenWithButton({
  applications,
  loading,
  failed,
  busy,
  prominent = false,
  onAct,
}: {
  applications: readonly NativeApplication[];
  loading: boolean;
  failed: boolean;
  busy: boolean;
  /** The empty state's size: taller, and it carries the action as words. */
  prominent?: boolean;
  onAct: (target: OpenTarget) => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const chevron = useRef<HTMLButtonElement>(null);
  const disabled = busy || loading;
  const label = openButtonLabel(applications, t);
  const current = applications.find((application) => application.default);

  // The chevron's own gesture toggles the menu; the main half never opens it, so
  // a reader who only ever presses the wider half is never surprised by one.
  const openMenu = (): void => setMenuOpen(true);

  return (
    <div className={styles.anchor}>
      <div
        className={styles.split}
        data-open-with="file"
        data-size={prominent ? "large" : "compact"}
        data-state={disabled ? "busy" : "idle"}
      >
        <Tooltip label={label} side="bottom">
          <button
            type="button"
            className={styles.main}
            aria-label={label}
            disabled={disabled}
            data-open-with-open
            onClick={() => onAct({ kind: "open" })}
          >
            {current === undefined ? (
              loading ? (
                <span className={styles.skeleton} aria-hidden />
              ) : (
                <ExternalIcon width={13} height={13} />
              )
            ) : current.icon === null ? (
              <ExternalIcon width={13} height={13} />
            ) : (
              <img className={styles.appIcon} src={current.icon} alt="" draggable={false} />
            )}
            {prominent ? <span className={styles.label}>{t("preview.open")}</span> : null}
          </button>
        </Tooltip>
        <button
          ref={chevron}
          type="button"
          className={styles.chevron}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("preview.openWithOther")}
          disabled={disabled}
          data-open-with-more
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        >
          <ChevronDownIcon width={prominent ? 14 : 10} height={prominent ? 14 : 10} />
        </button>
      </div>
      {menuOpen && chevron.current !== null ? (
        <OpenWithMenu
          anchor={chevron.current}
          rows={openMenuRows(applications, { failed }, t)}
          onDismiss={() => setMenuOpen(false)}
          onPick={(id) => {
            setMenuOpen(false);
            const target = rowTarget(id);
            if (target !== null) onAct(target);
          }}
        />
      ) : null}
    </div>
  );
}

/** The menu shell: placement, dismissal, and the portalled box it lives in. */
function OpenWithMenu({
  anchor,
  rows,
  onDismiss,
  onPick,
}: {
  anchor: HTMLElement;
  rows: readonly OpenMenuRow[];
  onDismiss: () => void;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const self = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);

  // Measured, then positioned: the width a menu needs is only known once it has
  // been laid out, so it spends one pass at the origin, invisible.
  useLayoutEffect(() => {
    const menu = self.current;
    if (menu === null) return;
    const rect = anchor.getBoundingClientRect();
    const at = placeMenuEnd(rect, menu, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPlaced({ left: at.left, top: at.top });
  }, [anchor]);

  useEffect(() => {
    const menu = self.current;
    if (menu === null) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      // A keydown that belongs to an IME composition belongs to the IME.
      if (event.isComposing) return;
      event.preventDefault();
      // Only take focus back if the menu had it: a menu opened with the mouse
      // must not pull focus out of wherever the reader was typing.
      const hadFocus = menu.contains(document.activeElement);
      onDismiss();
      if (hadFocus) anchor.focus();
    };
    // Capture, and on the window: a press anywhere else has to dismiss this
    // before whatever was pressed runs its own handlers.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      if (event.target instanceof Node && anchor.contains(event.target)) return;
      onDismiss();
    };
    // The menu is placed in viewport coordinates, so anything that moves the
    // trigger under it makes those coordinates wrong. Dismissing is cheaper than
    // re-measuring a menu the reader is leaving anyway.
    const onMove = (): void => onDismiss();

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [anchor, onDismiss]);

  return createPortal(
    <div
      ref={self}
      className={rightbar.menu}
      role="menu"
      aria-label={t("preview.openWithOther")}
      // `fixed` from here rather than the stylesheet: this menu shares the tab
      // menu's box, and that one hangs off its own trigger.
      style={{ position: "fixed", left: 0, top: 0, ...(placed ?? { visibility: "hidden" }) }}
      // React bubbles these to the panel behind; stopping them keeps a press on
      // an item from also reaching what the item is about.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <OpenWithMenuItems rows={rows} onPick={onPick} />
    </div>,
    document.body,
  );
}

type OpenWithState =
  | { status: "loading" }
  | { status: "ready"; desktop: boolean; applications: NativeApplication[] }
  | { status: "failed" };

/** What the preview tab needs to render and drive the control. */
export interface OpenWithControls {
  readonly available: boolean;
  readonly applications: readonly NativeApplication[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly busy: boolean;
  /** The host's own sentence about a refused gesture, until it is dismissed. */
  readonly failure: string | null;
  readonly act: (target: OpenTarget) => void;
  readonly dismissFailure: () => void;
}

/**
 * Ask the host what it can do with this file, once per file.
 *
 * A failed query is not the same as a headless host: the first leaves the
 * control in place and explains itself in the menu, because opening and
 * revealing may still work; the second removes the control, because there is
 * nothing on the other end to hand a path to.
 */
export function useOpenWith(projectId: string, path: string, enabled = true): OpenWithControls {
  const t = useT();
  const [state, setState] = useState<OpenWithState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A press and a keystroke can land on the same control in the same tick; the
  // ref is what makes the second a no-op rather than a second launch.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    setFailure(null);
    api
      .fileApplications(projectId, path)
      .then((answer) => {
        if (cancelled) return;
        setState({ status: "ready", desktop: answer.desktop, applications: answer.applications });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, enabled]);

  const act = useCallback(
    (target: OpenTarget) => {
      if (!enabled || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setFailure(null);
      const fallback = target.kind === "reveal" ? t("preview.revealFailed") : t("preview.openFailed");
      api
        .openWorkspaceFile(projectId, {
          path,
          action: target.kind === "reveal" ? "reveal" : "open",
          ...(target.kind === "open" && target.application !== undefined
            ? { application: target.application }
            : {}),
        })
        .then((answer) => {
          if (!answer.ok) setFailure(answer.error ?? fallback);
        })
        .catch((error: unknown) => {
          // A refused gesture answers with a sentence; only a broken request
          // throws, and then the host's wording is the error itself.
          setFailure((error as Error).message || fallback);
        })
        .finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
    },
    [projectId, path, t, enabled],
  );

  const loading = state.status === "loading";
  const failed = state.status === "failed";
  const desktop = state.status === "ready" && state.desktop;

  return {
    // Unknown is not the same as absent: while the answer is in flight, and when
    // it never arrives, the control stays where it is.
    available: enabled && (loading || failed || desktop),
    applications: state.status === "ready" ? state.applications : [],
    loading,
    failed,
    busy,
    failure,
    act,
    dismissFailure: () => setFailure(null),
  };
}
