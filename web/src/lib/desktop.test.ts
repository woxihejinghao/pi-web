import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopBridge, pathForFile } from "./desktop.ts";

const file = { name: "proj" } as File;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pathForFile", () => {
  it("answers null in a plain browser, where there is no bridge at all", () => {
    expect(desktopBridge()).toBeNull();
    expect(pathForFile(file)).toBeNull();
  });

  it("reads the path the shell resolved", () => {
    vi.stubGlobal("window", {
      piWebDesktop: {
        isDesktop: true,
        platform: "darwin",
        electronVersion: "44.0.0",
        getPathForFile: () => "/Users/dev/proj",
      },
    });
    expect(pathForFile(file)).toBe("/Users/dev/proj");
  });

  it("treats an empty answer and a throwing bridge as a miss", () => {
    vi.stubGlobal("window", {
      piWebDesktop: {
        isDesktop: true,
        platform: "darwin",
        electronVersion: "44.0.0",
        getPathForFile: () => "",
      },
    });
    expect(pathForFile(file)).toBeNull();

    vi.stubGlobal("window", {
      piWebDesktop: {
        isDesktop: true,
        platform: "darwin",
        electronVersion: "44.0.0",
        getPathForFile: () => {
          throw new Error("not a file");
        },
      },
    });
    expect(pathForFile(file)).toBeNull();
  });

  it("answers null on a shell too old to ship the function", () => {
    vi.stubGlobal("window", {
      piWebDesktop: { isDesktop: true, platform: "darwin", electronVersion: "28.0.0" },
    });
    expect(desktopBridge()).not.toBeNull();
    expect(pathForFile(file)).toBeNull();
  });
});
