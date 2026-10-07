import { describe, expect, it } from "vitest";
import { detectEnvironment, type EnvironmentSignals } from "./environment.ts";

/** Signals for a browser whose machine the test has not described yet. */
function browser(overrides: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return { desktopPlatform: null, userAgent: "", ...overrides };
}

describe("detectEnvironment", () => {
  it("reads the wrapped shell off the preload bridge", () => {
    // `process.platform`'s own vocabulary, which is not the UA's.
    expect(detectEnvironment(browser({ desktopPlatform: "darwin" }))).toEqual({
      runtime: "desktop",
      platform: "macos",
    });
    expect(detectEnvironment(browser({ desktopPlatform: "win32" }))).toEqual({
      runtime: "desktop",
      platform: "windows",
    });
    expect(detectEnvironment(browser({ desktopPlatform: "linux" }))).toEqual({
      runtime: "desktop",
      platform: "linux",
    });
  });

  it("names the machine off the user agent when unwrapped", () => {
    expect(
      detectEnvironment(
        browser({
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        }),
      ),
    ).toEqual({ runtime: "web", platform: "macos" });
    expect(
      detectEnvironment(
        browser({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0" }),
      ),
    ).toEqual({ runtime: "web", platform: "windows" });
    expect(
      detectEnvironment(
        browser({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" }),
      ),
    ).toEqual({ runtime: "web", platform: "linux" });
  });

  it("does not mistake Darwin for Windows", () => {
    // "Darwin" contains "win", which is why the macOS test comes first. Left in
    // as a test because the two regexes are one reorder away from swapping. The
    // device string here carries no other hint, so only the order decides it.
    expect(detectEnvironment(browser({ desktopPlatform: "darwin" })).platform).toBe("macos");
    expect(detectEnvironment(browser({ userAgent: "Darwin/23.0.0" })).platform).toBe("macos");
  });

  it("answers with a platform rather than nothing when there is nothing to read", () => {
    // A node test environment has no navigator, and a page under a hardened
    // privacy setting can look the same. Some platform has to be picked for
    // `primary` to mean anything, and the one whose defaults are the plainest
    // is the honest answer.
    expect(detectEnvironment(browser())).toEqual({ runtime: "web", platform: "linux" });
  });
});
