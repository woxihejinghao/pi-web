/**
 * Browser notifications, behind one module so nothing else touches the
 * `Notification` API directly.
 *
 * Two reasons for the wrapper. The API does not exist everywhere the store is
 * imported — jsdom in tests, and any non-secure origin in a real browser — so
 * every call needs the same "is it even here" guard. And the permission flow is
 * a user gesture followed by an async answer the caller has to turn into a
 * settings write, which is easier to get right in one place.
 */

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
  const api = notificationApi();
  if (api === null || api.permission !== "granted") return;
  try {
    const notification = new api(title, { body, tag });
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
