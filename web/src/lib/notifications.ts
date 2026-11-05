/**
 * Notifications, behind one module so nothing else touches the `Notification`
 * API or the shell bridge directly.
 *
 * Three reasons for the wrapper. The API does not exist everywhere the store is
 * imported — jsdom in tests, and any non-secure origin in a real browser — so
 * every call needs the same "is it even here" guard. The permission flow is a
 * user gesture followed by an async answer the caller has to turn into a
 * settings write, which is easier to get right in one place. And inside the
 * desktop shell the notice, the badge and the click all belong to the main
 * process, so those three jobs have a second implementation the rest of the UI
 * should not have to know about.
 */
import { PI_MARK_URL } from "./brand.ts";
import { desktopBridge, type PiWebDesktopBridge } from "./desktop.ts";

/**
 * The shell's notification bridge, when this page is inside the desktop window
 * and that shell is new enough to have it. A browser gets null here and keeps
 * the Web Notification path below.
 */
function shellNotifications(): PiWebDesktopBridge | null {
  const bridge = desktopBridge();
  return bridge?.notify !== undefined ? bridge : null;
}

/** True when notifications are raised by the shell rather than the browser. */
export function hasShellNotifications(): boolean {
  return shellNotifications() !== null;
}

/**
 * `unsupported` is not a permission value: it is this app's word for "there is
 * no `Notification` here", which the settings row has to render differently
 * from a denial (one can be undone by the user, the other cannot).
 */
export type NotificationCapability = "granted" | "denied" | "default" | "unsupported";

function notificationApi(): typeof Notification | null {
  return typeof Notification === "undefined" ? null : Notification;
}

/** The current permission, without ever prompting. */
export function notificationCapability(): NotificationCapability {
  const api = notificationApi();
  return api === null ? "unsupported" : api.permission;
}

/**
 * Ask the browser for permission. Must be called from a user gesture — a call
 * made on page load is ignored by every current browser — which is why the
 * settings switch is the only caller.
 */
export async function requestNotificationPermission(): Promise<NotificationCapability> {
  const api = notificationApi();
  if (api === null) return "unsupported";
  try {
    return await api.requestPermission();
  } catch {
    // Safari can reject the promise outright instead of answering `denied`;
    // either way the permission was not granted.
    return "denied";
  }
}

/**
 * Whether this page is in front of the user right now.
 *
 * Both halves are asked because they fail apart: a hidden tab — switched away
 * from or minimised, the two things the browser reports as hidden, since it
 * does not judge whether a window is covered — cannot be being read, and a
 * window that does not hold focus is one the user has left for something else
 * even while the tab stays visible on screen. A session being the selected one
 * says nothing about either.
 *
 * Without a document — the store is imported in tests, and in any non-DOM host
 * — the answer is "attended": nothing can observe the user, but the finish
 * being announced is real either way, so the tie goes to the notice. An extra
 * banner is dismissed in a second; a finish held back is the whole reason this
 * path exists.
 */
export function pageIsAttended(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/**
 * Show one notification, reusing `tag` so a session's newer notice replaces its
 * older rather than stacking. Silently does nothing without permission — the
 * caller has already checked the preference, and a toast is never worth an
 * error path.
 */
export function showNotification(
  title: string,
  body: string,
  tag: string,
  onClick?: () => void,
): void {
  const shellNotify = shellNotifications()?.notify;
  if (shellNotify !== undefined) {
    // The shell owns the notice from here. Its click comes back over
    // `subscribeNotificationClicks` rather than this call's `onClick`, because
    // the notice outlives the call — the page may even have reloaded since.
    shellNotify({ title, body, tag });
    return;
  }
  const api = notificationApi();
  if (api === null || api.permission !== "granted") return;
  try {
    // The mark is passed in because nothing else puts one on the notice: the
    // platform's own line above it carries the origin (`127.0.0.1` for a server
    // on this machine), and without an icon the banner falls back to the
    // browser's. Same file the tab is wearing — full-bleed square, the platform
    // scales it.
    const notification = new api(title, { body, tag, icon: PI_MARK_URL });
    notification.onclick = () => {
      // Focusing is the whole point: the notice arrives because the user was
      // looking somewhere else. Guarded because the store is imported in test
      // environments that have no window at all.
      if (typeof window !== "undefined") window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Some mobile browsers only allow construction from a service worker. A
    // missing toast must never take the completion path down with it.
  }
}

/** The last count handed to the shell, so a settled store is not an IPC send. */
let lastBadge = -1;

/**
 * Mirror the unread count onto the shell's icon. A no-op in a browser, and a
 * no-op when the number has not moved — the caller is a store subscription that
 * fires on every state change.
 */
export function setNotificationBadge(count: number): void {
  const setBadge = shellNotifications()?.setBadge;
  if (setBadge === undefined || count === lastBadge) return;
  lastBadge = count;
  setBadge(count);
}

/**
 * Route a click on a shell notification back to the session it named. Returns
 * the unsubscribe, or a no-op in a browser so a caller can register
 * unconditionally.
 */
export function subscribeNotificationClicks(listener: (sessionPath: string) => void): () => void {
  const subscribe = shellNotifications()?.onNotificationClick;
  return subscribe === undefined ? () => {} : subscribe(listener);
}
