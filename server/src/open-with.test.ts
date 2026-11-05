import { describe, expect, it } from "vitest";
import {
  canOpenNatively,
  listFileApplications,
  openFileWithApplication,
  openFileWithDefault,
  revealFile,
  NativeCommandError,
  type NativeCommand,
  type NativeInternals,
} from "./open-with.ts";

/** What a stand-in command answers: stdout, or a non-zero exit to raise. */
interface ScriptedReply {
  stdout?: string;
  code?: number;
}

/**
 * A desktop that records instead of launching.
 *
 * A command with no scripted reply answers an empty success — a launch has no
 * interesting output, and the assertions these tests make are about which
 * commands ran, not about what they printed. Only the queries whose *answer*
 * matters (`osascript`, `defaults`, `wslpath`) are scripted.
 *
 * `env` defaults to an empty object rather than the real environment: a test
 * host that happens to be inside an ssh session or a headless Linux container
 * would otherwise decide the answers, which is exactly what these tests are
 * about.
 */
function desktop(
  platform: NodeJS.Platform,
  replies: Record<string, ScriptedReply | string>,
  env: NodeJS.ProcessEnv = {},
): { internals: NativeInternals; commands: string[]; argv: string[][] } {
  const calls: NativeCommand[] = [];
  const internals: NativeInternals = {
    platform,
    env,
    run: async (command) => {
      calls.push(command);
      const reply = replies[command.command];
      if (reply === undefined) return "";
      const scripted: ScriptedReply = typeof reply === "string" ? { stdout: reply } : reply;
      if (scripted.code !== undefined) {
        throw new NativeCommandError(`${command.command} exited with ${scripted.code}`, scripted.code);
      }
      return scripted.stdout ?? "";
    },
  };
  return {
    internals,
    // Getters, not snapshots: the calls happen after this object is built.
    // `commands` is for reading, `argv` for the cases where the *argument
    // boundary* is the rule under test.
    get commands() {
      return calls.map((call) => [call.command, ...call.args].join(" "));
    },
    get argv() {
      return calls.map((call) => [call.command, ...call.args]);
    },
  };
}

/** One macOS handler as the query script reports it. */
function macApp(
  path: string,
  name: string,
  options: { default?: boolean; bundle?: string | null; version?: string | null; icon?: string } = {},
): unknown {
  return {
    id: path,
    name,
    default: options.default ?? false,
    icon: options.icon ?? null,
    // `??` would turn the explicit null back into a bundle, and a null bundle is
    // exactly what "this application has no identifier" means here.
    bundle: options.bundle === undefined ? "com.example.app" : options.bundle,
    version: options.version === undefined ? "1.0" : options.version,
  };
}

describe("canOpenNatively", () => {
  it("answers for the platforms that always carry a desktop", () => {
    expect(canOpenNatively({ platform: "darwin", env: {} })).toBe(true);
    expect(canOpenNatively({ platform: "win32", env: {} })).toBe(true);
  });

  it("asks Linux for a display server", () => {
    // A headless server has no opener to hand a path to; the preview hides its
    // controls rather than offering a button that spawns xdg-open into nothing.
    expect(canOpenNatively({ platform: "linux", env: {} })).toBe(false);
    expect(canOpenNatively({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(canOpenNatively({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });

  it("counts WSL as the Windows desktop it hands paths to", () => {
    expect(canOpenNatively({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBe(true);
    expect(
      canOpenNatively({ platform: "linux", env: {}, osRelease: "5.15.90.1-microsoft-standard-WSL2" }),
    ).toBe(true);
  });

  it("refuses an ssh session, where there is no desktop on the other end", () => {
    expect(canOpenNatively({ platform: "darwin", env: { SSH_CONNECTION: "10.0.0.1 5 10.0.0.2 22" } })).toBe(
      false,
    );
    expect(canOpenNatively({ platform: "darwin", env: { SSH_TTY: "/dev/ttys001" } })).toBe(false);
  });

  it("lets a caller stand in for an unknown host", () => {
    expect(canOpenNatively({ platform: "linux", env: {}, desktop: true })).toBe(true);
    expect(canOpenNatively({ platform: "darwin", env: {}, desktop: false })).toBe(false);
  });

  it("refuses a platform it has no opener for", () => {
    expect(canOpenNatively({ platform: "freebsd", env: {} })).toBe(false);
  });
});

describe("listFileApplications", () => {
  it("answers nothing, without asking, on a platform with no association query", async () => {
    // Windows and Linux open and reveal through the shell but cannot list what
    // the shell would use, so the menu there is open plus show-location rather
    // than a list this module would have to invent.
    const host = desktop("win32", {});

    expect(await listFileApplications("C:\\work\\a.txt", host.internals)).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  it("asks LaunchServices about the one file, with icons", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([macApp("/Applications/Cursor.app", "Cursor", { default: true })]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications).toEqual([
      { id: "/Applications/Cursor.app", name: "Cursor", default: true, icon: null },
    ]);
    // The script is passed as source and the path as argv, never the other way
    // round: an executed path would be a command injection with extra steps.
    expect(host.commands[0]).toContain("osascript -l JavaScript -e ");
    expect(host.commands[0]!.endsWith("/work/a.ts icons")).toBe(true);
  });

  it("keeps the system's preference order and its default mark", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/Applications/Zed.app", "Zed"),
        macApp("/Applications/VS Code.app", "Visual Studio Code", { default: true }),
      ]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications.map((app) => app.name)).toEqual(["Zed", "Visual Studio Code"]);
    expect(applications.filter((app) => app.default).map((app) => app.id)).toEqual([
      "/Applications/VS Code.app",
    ]);
  });

  it("collapses copies of one application the way Finder shows them", async () => {
    // A self-updating app stages a second copy on disk and LaunchServices
    // registers both; without this the menu would list Cursor twice.
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/Applications/Cursor.app", "Cursor", { bundle: "com.todesktop.230313mzl4w4u92", version: "0.42.0" }),
        macApp("/Users/me/Library/Application Support/Cursor/Cursor.app", "Cursor", {
          bundle: "com.todesktop.230313mzl4w4u92",
          version: "0.43.0",
        }),
      ]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications).toHaveLength(1);
    // The newest copy wins, and it keeps the position the app already had.
    expect(applications[0]!.id).toBe("/Users/me/Library/Application Support/Cursor/Cursor.app");
    expect(applications[0]!.default).toBe(false);
  });

  it("keeps the copy the system defaults to, whatever its version", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/Applications/Cursor.app", "Cursor", { bundle: "com.x", version: "0.42.0", default: true }),
        macApp("/opt/Cursor.app", "Cursor", { bundle: "com.x", version: "9.9.9" }),
      ]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications.map((app) => app.id)).toEqual(["/Applications/Cursor.app"]);
    expect(applications[0]!.default).toBe(true);
  });

  it("keeps side-by-side installs that carry different names", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/Applications/VS Code.app", "Visual Studio Code"),
        macApp("/Applications/VS Code Insiders.app", "Visual Studio Code Insiders"),
      ]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications.map((app) => app.name)).toEqual([
      "Visual Studio Code",
      "Visual Studio Code Insiders",
    ]);
  });

  it("never collapses two applications it cannot name a bundle for", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/A.app", "Mystery", { bundle: null }),
        macApp("/B.app", "Mystery", { bundle: null }),
      ]),
    });

    expect(await listFileApplications("/work/a.ts", host.internals)).toHaveLength(2);
  });

  it("carries an icon through when the query produced one", async () => {
    const host = desktop("darwin", {
      osascript: JSON.stringify([
        macApp("/Applications/Cursor.app", "Cursor", { icon: "data:image/png;base64,AAAA" }),
      ]),
    });

    const applications = await listFileApplications("/work/a.ts", host.internals);

    expect(applications[0]!.icon).toBe("data:image/png;base64,AAAA");
  });

  it("refuses an answer it did not produce", async () => {
    const host = desktop("darwin", { osascript: JSON.stringify([{ id: "/A.app" }]) });

    await expect(listFileApplications("/work/a.ts", host.internals)).rejects.toThrow(
      "Invalid native application entry",
    );
  });

  it("refuses an empty answer rather than reading it as no applications", async () => {
    // An empty list is a real answer (a file nothing is registered for); an
    // empty *response* is a script that did not run, which must not look the
    // same as one that ran and found nothing.
    const host = desktop("darwin", { osascript: "  \n" });

    await expect(listFileApplications("/work/a.ts", host.internals)).rejects.toThrow(
      "osascript returned no application list",
    );
  });
});

describe("openFileWithDefault", () => {
  it("hands an ordinary file to the platform's own opener", async () => {
    const host = desktop("darwin", {});

    await openFileWithDefault("/work/a.ts", host.internals);

    expect(host.commands).toEqual(["open /work/a.ts"]);
  });

  it("prefers the browser for a document a browser renders", async () => {
    // "Default application" for a .html is an editor when one claimed the
    // extension, while the gesture — show me the page — means the browser.
    const host = desktop("darwin", {
      defaults: [
        "{",
        "    LSHandlers =     (",
        "                {",
        '            LSHandlerRoleAll = "com.google.Chrome";',
        '            LSHandlerURLScheme = "https";',
        "        }",
        "    );",
        "}",
      ].join("\n"),
    });

    await openFileWithDefault("/work/page.html", host.internals);

    expect(host.commands).toEqual([
      "defaults read com.apple.LaunchServices/com.apple.launchservices.secure",
      "open -b com.google.Chrome /work/page.html",
    ]);
  });

  it("ignores a preferred-version record when naming the browser", async () => {
    // `LSHandlerPreferredVersions` carries a role of its own — the browser
    // registered for a scheme *version* rather than the one in effect — and it
    // nests the handler block in braces. Reading past it is what leaves the
    // block matchable at all, and what leaves the outer role as the first one.
    const host = desktop("darwin", {
      defaults: [
        "{",
        "    LSHandlers =     (",
        "                {",
        "            LSHandlerPreferredVersions =             {",
        '                LSHandlerRoleAll = "com.apple.Safari";',
        "            };",
        '            LSHandlerRoleAll = "com.google.Chrome";',
        '            LSHandlerURLScheme = "https";',
        "        }",
        "    );",
        "}",
      ].join("\n"),
    });

    await openFileWithDefault("/work/page.svg", host.internals);

    expect(host.commands).toEqual([
      "defaults read com.apple.LaunchServices/com.apple.launchservices.secure",
      "open -b com.google.Chrome /work/page.svg",
    ]);
  });

  it("falls back to the association when no browser can be named", async () => {
    // A fresh account never changed a default, so `defaults read` exits 1 with
    // no record at all and the content-type handler is the system's own choice.
    const host = desktop("darwin", { defaults: { code: 1 } });

    await openFileWithDefault("/work/page.html", host.internals);

    expect(host.commands).toEqual([
      "defaults read com.apple.LaunchServices/com.apple.launchservices.secure",
      "open /work/page.html",
    ]);
  });

  it("follows $BROWSER on Linux and xdg-open without it", async () => {
    const withBrowser = desktop("linux", {}, { BROWSER: "firefox", DISPLAY: ":0" });
    await openFileWithDefault("/work/page.html", withBrowser.internals);
    expect(withBrowser.commands).toEqual(["firefox /work/page.html"]);

    const without = desktop("linux", {}, { DISPLAY: ":0" });
    await openFileWithDefault("/work/page.html", without.internals);
    expect(without.commands).toEqual(["xdg-open /work/page.html"]);
  });

  it("hands a Windows path to Explorer as one encoded argument", async () => {
    const host = desktop("win32", {});

    await openFileWithDefault("C:\\Users\\me\\a,b=c.txt", host.internals);

    // Explorer splits its own command line at commas and equals signs, so a raw
    // path would silently open a different target.
    expect(host.commands).toEqual(["explorer.exe file:///C:/Users/me/a%2Cb%3Dc.txt"]);
  });

  it("keeps non-ASCII characters literal for Explorer", async () => {
    // Explorer rejects percent-encoded non-ASCII in a file URI and opens the
    // user's Documents folder instead; it resolves the literal characters.
    const host = desktop("win32", {});

    await openFileWithDefault("C:\\文档\\a.txt", host.internals);

    expect(host.commands).toEqual(["explorer.exe file:///C:/文档/a.txt"]);
  });

  it("accepts Explorer's delegated-handoff exit code", async () => {
    // Explorer exits 1 after passing the request to the desktop process already
    // running, so exit 1 means the shell took it.
    const host = desktop("win32", { "explorer.exe": { code: 1 } });

    await expect(openFileWithDefault("C:\\a.txt", host.internals)).resolves.toBeUndefined();
  });

  it("still raises a real Explorer failure", async () => {
    const host = desktop("win32", { "explorer.exe": { code: 3 } });

    await expect(openFileWithDefault("C:\\a.txt", host.internals)).rejects.toThrow(
      "explorer.exe exited with 3",
    );
  });

  it("opens a WSL path through the Windows desktop", async () => {
    const host = desktop("linux", { wslpath: "C:\\work\\a.txt\n" }, { WSL_DISTRO_NAME: "Ubuntu" });

    await openFileWithDefault("/mnt/c/work/a.txt", host.internals);

    expect(host.commands).toEqual(["wslpath -w /mnt/c/work/a.txt", "explorer.exe file:///C:/work/a.txt"]);
  });

  it("refuses a platform it has no opener for", async () => {
    const host = desktop("freebsd", {});

    await expect(openFileWithDefault("/work/a.txt", host.internals)).rejects.toThrow(
      "这台主机不支持用默认应用打开：freebsd",
    );
  });
});

describe("openFileWithApplication", () => {
  const REGISTERED = JSON.stringify([
    macApp("/Applications/Cursor.app", "Cursor", { default: true }),
    macApp("/Applications/Zed.app", "Zed"),
  ]);

  it("re-checks the application against the registered handlers, then launches it", async () => {
    // The id came from an earlier answer and may be stale by now; the launch is
    // the one place a forged id would reach the operating system, so the list is
    // asked again — without icons, which are not needed to validate.
    const host = desktop("darwin", {
      osascript: REGISTERED,
      open: "",
    });

    await openFileWithApplication("/work/a.ts", "/Applications/Zed.app", host.internals);

    expect(host.commands).toHaveLength(2);
    expect(host.commands[0]!.endsWith("/work/a.ts handlers")).toBe(true);
    expect(host.commands[1]).toBe("open -a /Applications/Zed.app /work/a.ts");
  });

  it("refuses an application that is not registered for this file", async () => {
    const host = desktop("darwin", { osascript: REGISTERED });

    await expect(
      openFileWithApplication("/work/a.ts", "/Applications/Evil.app", host.internals),
    ).rejects.toThrow("所选应用没有注册为这个文件的打开方式");
    expect(host.commands).toHaveLength(1);
  });

  it("refuses to name an application on a platform with no list to check against", async () => {
    const host = desktop("win32", {});

    await expect(
      openFileWithApplication("C:\\a.txt", "cmd.exe", host.internals),
    ).rejects.toThrow("这台主机不支持指定应用打开：win32");
  });
});

describe("revealFile", () => {
  it("selects the file in Finder", async () => {
    const host = desktop("darwin", {});

    await revealFile("/work/a.ts", host.internals);

    expect(host.commands).toEqual(["open -R /work/a.ts"]);
  });

  it("selects the file in Explorer", async () => {
    const host = desktop("win32", {});

    await revealFile("C:\\work\\a.ts", host.internals);

    // `/select,` and the target are separate argv entries: Explorer splits its
    // own command line, and a single joined string is what it would re-split.
    expect(host.argv).toEqual([["explorer.exe", "/select,", "file:///C:/work/a.ts"]]);
  });

  it("opens the directory through the Linux desktop's file manager", async () => {
    // Linux file managers have no portable "select this file", so the parent is
    // what opens.
    const host = desktop("linux", {}, { DISPLAY: ":0" });

    await revealFile("/work/deep/a.ts", host.internals);

    expect(host.commands).toEqual(["xdg-open /work/deep"]);
  });

  it("translates a WSL path before Explorer selects it", async () => {
    const host = desktop("linux", { wslpath: "C:\\work\\a.ts\n" }, { WSL_DISTRO_NAME: "Ubuntu" });

    await revealFile("/mnt/c/work/a.ts", host.internals);

    expect(host.argv).toEqual([
      ["wslpath", "-w", "/mnt/c/work/a.ts"],
      ["explorer.exe", "/select,", "file:///C:/work/a.ts"],
    ]);
  });

  it("refuses a host with no file manager to show anything in", async () => {
    const host = desktop("freebsd", {});

    await expect(revealFile("/work/a.ts", host.internals)).rejects.toThrow(
      "这台主机没有可以显示文件位置的文件管理器：freebsd",
    );
  });
});
