import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_MARK_URL } from "./brand.ts";

/**
 * The desktop shell's half of notifications, which is the only half with a
 * bridge to speak to.
 *
 * Every test re-imports the module: the badge remembers the last count it sent
 * in module state, and that memory is part of what is under test here.
 */
async function freshNotifications() {
  vi.resetModules();
  return import("./notifications.ts");
}

/** The notification half of `preload.cts`'s bridge, with spies on it. */
function stubShell() {
  const shell = {
    notify: vi.fn(),
    setBadge: vi.fn(),
    onNotificationClick: vi.fn((_listener: (sessionPath: string) => void) => () => {}),
  };
  vi.stubGlobal("window", {
    piWebDesktop: {
      isDesktop: true,
      platform: "darwin",
      electronVersion: "44.0.0",
      ...shell,
    },
  });
  return shell;
}

/** A stand-in for the browser API, which the shell path must leave alone. */
function stubWebNotifications(shown: { title: string; options?: NotificationOptions }[]): void {
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, options });
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("outside the shell", () => {
  it("keeps the Web Notification path and makes the shell hooks harmless", async () => {
    const shown: { title: string; options?: NotificationOptions }[] = [];
    stubWebNotifications(shown);
    const { hasShellNotifications, setNotificationBadge, showNotification, subscribeNotificationClicks } =
      await freshNotifications();

    expect(hasShellNotifications()).toBe(false);
    showNotification("t", "b", "tag");
    expect(shown.map((notice) => notice.title)).toEqual(["t"]);
    // The same mark the tab wears: without one the banner falls back to the
    // browser's own icon, and the platform's line above it already carries the
    // origin rather than the app's name.
    expect(shown[0]?.options?.icon).toBe(PI_MARK_URL);
    // Both are no-ops a caller can make unconditionally.
    setNotificationBadge(3);
    expect(subscribeNotificationClicks(() => {})).toBeTypeOf("function");
  });

  it("stays inert on a shell older than the notification functions", async () => {
    vi.stubGlobal("window", {
      piWebDesktop: { isDesktop: true, platform: "darwin", electronVersion: "28.0.0" },
    });
    const { hasShellNotifications, setNotificationBadge, subscribeNotificationClicks } =
      await freshNotifications();

    expect(hasShellNotifications()).toBe(false);
    setNotificationBadge(1);
    expect(subscribeNotificationClicks(() => {})).toBeTypeOf("function");
  });
});

describe("page attendance", () => {
  /** The two things a page can tell us about whether it is being read. */
  function stubPage(visibilityState: DocumentVisibilityState, focused: boolean): void {
    vi.stubGlobal("document", { visibilityState, hasFocus: () => focused });
  }

  it("answers 'attended' when there is no document to ask", async () => {
    const { pageIsAttended } = await freshNotifications();

    // Nothing here can observe the user, so nothing is invented on their
    // behalf — the store's rule for a finish it cannot place.
    expect(typeof document).toBe("undefined");
    expect(pageIsAttended()).toBe(true);
  });

  it("reads a hidden tab, and a window someone else is typing in, as elsewhere", async () => {
    const { pageIsAttended } = await freshNotifications();

    stubPage("hidden", false);
    expect(pageIsAttended()).toBe(false);

    // Visible — on a second screen, or behind the app the user is actually
    // working in — and nowhere near their attention either way.
    stubPage("visible", false);
    expect(pageIsAttended()).toBe(false);

    stubPage("visible", true);
    expect(pageIsAttended()).toBe(true);
  });
});

describe("inside the shell", () => {
  it("hands the notice to the shell instead of constructing a Web Notification", async () => {
    const shell = stubShell();
    const constructed = vi.fn();
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      constructor() {
        constructed();
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    const { hasShellNotifications, showNotification } = await freshNotifications();
    expect(hasShellNotifications()).toBe(true);

    showNotification("修复登录问题", "会话任务已完成", "/sessions/one.jsonl");

    expect(shell.notify).toHaveBeenCalledWith({
      title: "修复登录问题",
      body: "会话任务已完成",
      tag: "/sessions/one.jsonl",
    });
    expect(constructed).not.toHaveBeenCalled();
  });

  it("sends a badge only when the number moves", async () => {
    const shell = stubShell();
    const { setNotificationBadge } = await freshNotifications();

    setNotificationBadge(2);
    setNotificationBadge(2);
    expect(shell.setBadge).toHaveBeenCalledTimes(1);

    setNotificationBadge(0);
    expect(shell.setBadge).toHaveBeenLastCalledWith(0);
    expect(shell.setBadge).toHaveBeenCalledTimes(2);
  });

  it("routes a click to the listener and resolves the unsubscribe", async () => {
    const shell = stubShell();
    const listeners: ((sessionPath: string) => void)[] = [];
    const unsubscribe = vi.fn();
    shell.onNotificationClick.mockImplementation((listener: (sessionPath: string) => void) => {
      listeners.push(listener);
      return unsubscribe;
    });

    const { subscribeNotificationClicks } = await freshNotifications();
    const seen: string[] = [];
    const stop = subscribeNotificationClicks((sessionPath) => seen.push(sessionPath));

    listeners[0]?.("/sessions/one.jsonl");
    stop();

    expect(seen).toEqual(["/sessions/one.jsonl"]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
