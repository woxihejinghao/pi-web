/**
 * What the preview's open control offers, as plain data.
 *
 * dsh's own control is three rules in one component: which application the main
 * button opens, what the menu lists, and where "show file location" sits. They
 * are split out here because they are the part with a decision in them — the
 * markup around them is a button, and the portalled shell is DOM behavior this
 * repo's test environment cannot render.
 *
 * One deliberate difference from dsh. There, a file with no registered
 * application makes *reveal* the main action, and the menu loses its chevron
 * entirely. That is right for a host that can always answer "what opens this?"
 * — but a host with no association query would then offer only the file
 * manager, and the default application, which is what "open" means on every
 * desktop, would be unreachable. So the main action is always the system's own
 * opener and reveal is always the menu's last row, in a menu that always has
 * one. Everything else follows dsh: the item that the system would pick is
 * marked, choosing an application here never changes that choice, and a failed
 * query explains itself in the menu instead of removing the control.
 */
import type { NativeApplication } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

/** What one gesture asks the host to do. */
export type OpenTarget =
  | { readonly kind: "open"; readonly application?: string }
  | { readonly kind: "reveal" };

/** One row of the menu. */
export interface OpenMenuRow {
  /** `app:<id>` for an application, `reveal`, or `unavailable` for the notice. */
  readonly id: string;
  readonly label: string;
  /** A `data:` icon for an application row; null for the two built-in ones. */
  readonly icon: string | null;
  readonly disabled: boolean;
  /** A rule above this row, separating the file's own applications from ours. */
  readonly divider: boolean;
}

/**
 * The application the system would open this file with.
 *
 * Not `applications[0]`: the host reports the association, and if it reports
 * none the main button still opens the file the system's own way — there is
 * just no name to print. Order is the host's, which is the reader's Finder
 * order rather than ours to invent.
 */
export function systemApplication(
  applications: readonly NativeApplication[],
): NativeApplication | undefined {
  return applications.find((application) => application.default);
}

/** What the main button says it will do, used as its tooltip. */
export function openButtonLabel(
  applications: readonly NativeApplication[],
  t: Translate,
): string {
  const application = systemApplication(applications);
  return application === undefined
    ? t("preview.openDefault")
    : t("preview.openWith", { app: application.name });
}

/**
 * The menu's rows, in order.
 *
 * The applications first — the system's pick marked — then, when the query
 * failed, the one line that says so, then always the file-location row behind a
 * rule. That order is the point: a reader opening this menu is looking for an
 * application they already have in mind, and the file manager is the fallback
 * they reach for when the list does not have it.
 */
export function openMenuRows(
  applications: readonly NativeApplication[],
  options: { readonly failed: boolean },
  t: Translate,
): readonly OpenMenuRow[] {
  const current = systemApplication(applications);
  const rows: OpenMenuRow[] = applications.map((application) => ({
    id: `app:${application.id}`,
    label:
      application.id === current?.id
        ? t("preview.defaultApp", { app: application.name })
        : application.name,
    icon: application.icon,
    disabled: false,
    divider: false,
  }));
  if (options.failed) {
    rows.push({
      id: "unavailable",
      label: t("preview.appsError"),
      icon: null,
      disabled: true,
      divider: false,
    });
  }
  rows.push({
    id: "reveal",
    label: t("preview.reveal"),
    icon: null,
    disabled: false,
    // Behind a rule, and last: it is a different kind of answer from "open it
    // with this".
    divider: true,
  });
  return rows;
}

/**
 * What pressing a row asks for.
 *
 * `unavailable` is not pressable and answers null, so a disabled row cannot
 * turn into a launch if a stray event reaches it.
 */
export function rowTarget(id: string): OpenTarget | null {
  if (id === "reveal") return { kind: "reveal" };
  if (id === "unavailable") return null;
  return { kind: "open", application: id.slice("app:".length) };
}

/** Gap kept between the menu and its trigger, and between it and the window. */
const MENU_GAP = 2;

/**
 * Where a menu opened from `anchor` lands: below it, right-aligned to it.
 *
 * Right-aligned because the trigger sits at the right end of the preview's
 * header, where a menu growing rightwards would leave the window. Flips above
 * the trigger when there is no room below, and stops at the window's edges
 * rather than sliding off them.
 *
 * Takes the numbers rather than elements so the arithmetic can be checked
 * without a layout engine; `menu` only has to answer `offsetWidth`/`offsetHeight`.
 */
export function placeMenuEnd(
  anchor: { right: number; top: number; bottom: number },
  menu: { offsetWidth: number; offsetHeight: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const rightAligned = anchor.right - menu.offsetWidth;
  const furthest = viewport.width - menu.offsetWidth - MENU_GAP;
  const below = anchor.bottom + MENU_GAP;
  const fitsBelow = below + menu.offsetHeight <= viewport.height;
  return {
    left: Math.max(MENU_GAP, Math.min(rightAligned, furthest)),
    top: fitsBelow ? below : Math.max(MENU_GAP, anchor.top - menu.offsetHeight - MENU_GAP),
  };
}
