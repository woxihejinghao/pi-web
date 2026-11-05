/**
 * Native "open with" for the document preview.
 *
 * Only the machine running pi can launch an application, so the server owns
 * this: the browser cannot reach the desktop, and a path the workspace API
 * already refuses to hand out is a path this must refuse to open. Every entry
 * point takes an absolute path that the workspace resolver has already
 * canonicalized inside a project, and opening *with* an application
 * re-validates the id against the current registration list, so a stale or
 * forged id from an earlier answer cannot launch something arbitrary.
 *
 * macOS is the platform the association query covers: LaunchServices is asked
 * about one file, and app copies that share a bundle id and display name
 * collapse to one entry the way Finder shows them. Windows and Linux open and
 * reveal through the shell's own resolution (`explorer.exe`, `xdg-open`) but
 * carry no association query, so their menu offers open and show-location
 * rather than a list — the same fallback dsh documents for a host with no
 * adapter, and the reason nothing here pretends to enumerate what it cannot.
 *
 * Everything is injectable — platform, environment, kernel release, and the
 * command runner — so a test pins each branch instead of asserting around
 * whatever the host happens to have installed.
 */
import { spawn } from "node:child_process";
import { release as osRelease } from "node:os";
import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";

/** One application the desktop can open a file with. */
export interface NativeApplication {
  /** Stable identity, and what the launcher is handed back: the macOS bundle path. */
  id: string;
  /** Display name, as the operating system localizes it. */
  name: string;
  /** Whether the operating system would pick this one for this file. */
  default: boolean;
  /** `data:image/png;base64,…`, or null when no icon could be produced. */
  icon: string | null;
}

/** One shell-free command about to run. */
export interface NativeCommand {
  command: string;
  args: string[];
  /**
   * Whether a console window may be shown. Windows hosts get `false` from the
   * default below; the one command that needs `true` is `explorer.exe`, whose
   * window *is* the thing being opened.
   */
  windowsHide?: boolean;
  timeoutMs?: number;
}

/**
 * Run one command and answer its stdout.
 *
 * Rejects with a {@link NativeCommandError} on a non-zero exit, so a caller
 * that can accept one particular status can say so; everything else — a
 * missing binary, a timeout — is a failure with the command named in it.
 */
export type NativeRunner = (command: NativeCommand) => Promise<string>;

/** A command that ran and failed, carrying the status a caller may accept. */
export class NativeCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "NativeCommandError";
  }
}

/** What a caller can stand in for; every field defaults to this host. */
export interface NativeInternals {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Kernel release, injected so the WSL branch is reachable off a WSL host. */
  osRelease?: string;
  run?: NativeRunner;
  /** Whether a desktop can take a launch at all; injected for a headless host. */
  desktop?: boolean;
}

/**
 * Querying the association list is the one call that talks to the window server
 * (the icons are rendered there), so it gets the longer rope; a launch either
 * hands over quickly or is not going to.
 */
const QUERY_TIMEOUT_MS = 8000;
const LAUNCH_TIMEOUT_MS = 5000;

/** Documents a browser renders, as opposed to ones an editor merely edits. */
const BROWSER_DOCUMENTS = new Set([".html", ".htm", ".xhtml", ".svg"]);

/** A non-empty value is a marker that is actually set. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * The macOS association query.
 *
 * AppKit runs inside the system JXA host and the path arrives as argv, never as
 * executable source. `URLsForApplicationsToOpenURL` answers in the system's own
 * preference order with the default somewhere inside it, which is what makes
 * the "(default)" mark possible without a second question.
 */
const MAC_APPLICATIONS = `
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var image = null;
    if (argv[1] === 'icons') {
      var icon = workspace.iconForFile(path);
      var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      thumbnail.lockFocus;
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      thumbnail.unlockFocus;
      var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      image = png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    }
    var bundle = $.NSBundle.bundleWithURL(url);
    var bundleId = bundle.isNil() || bundle.bundleIdentifier.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: image,
      bundle: bundleId,
      version: version === null || version.isNil() ? null : String(ObjC.unwrap(version))
    });
  }
  return JSON.stringify(apps);
}`;

const runCommand: NativeRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      // A console child flashing a window is noise on Windows; a GUI launcher
      // asked for the hidden-window treatment would not appear at all, which is
      // why the one caller that opens a window turns this off.
      windowsHide: command.windowsHide ?? true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(`${command.command} timed out`)));
    }, command.timeoutMs ?? LAUNCH_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // ENOENT mostly: the command this platform opens with is not installed.
      settle(() => reject(new Error(`${command.command}: ${err.message}`)));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolve(stdout));
        return;
      }
      const detail = stderr.trim();
      settle(() =>
        reject(
          new NativeCommandError(
            `${command.command} exited with ${code}${detail === "" ? "" : `: ${detail}`}`,
            code,
          ),
        ),
      );
    });
  });

const run = (internals: NativeInternals): NativeRunner => internals.run ?? runCommand;

/** Whether this host is WSL, which hands its paths to the Windows desktop. */
function isWsl(internals: NativeInternals): boolean {
  const env = internals.env ?? process.env;
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true;
  return (internals.osRelease ?? osRelease()).toLowerCase().includes("microsoft");
}

/**
 * Whether handing a path to the native opener can work at all.
 *
 * macOS and Windows always carry a desktop opener; Linux does when it is WSL
 * (the Windows desktop takes the path) or a display server is announced. A
 * session reached over ssh has no desktop on the other end of the connection,
 * so it answers false — dsh hides its controls for the same reason, and a
 * button that spawns `xdg-open` into nothing is worse than no button.
 */
export function canOpenNatively(internals: NativeInternals = {}): boolean {
  if (internals.desktop !== undefined) return internals.desktop;
  const env = internals.env ?? process.env;
  if (present(env.SSH_CONNECTION) || present(env.SSH_TTY)) return false;
  const platform = internals.platform ?? process.platform;
  if (platform === "darwin" || platform === "win32") return true;
  if (platform !== "linux") return false;
  return isWsl(internals) || present(env.DISPLAY) || present(env.WAYLAND_DISPLAY);
}

/**
 * The apps macOS reports for this file, one entry per application.
 *
 * Handlers only: `open -a` takes a bundle path, and the path a user picks is
 * the one to launch. The list order is the system's, so the caller can let the
 * first entry stand in for a default it cannot name.
 */
export async function listFileApplications(
  absolutePath: string,
  internals: NativeInternals = {},
): Promise<NativeApplication[]> {
  const platform = internals.platform ?? process.platform;
  if (platform !== "darwin") return [];
  const applications = await queryMacApplications(absolutePath, internals, true);
  return dedupeMacApplications(applications).map(({ id, name, default: preferred, icon }) => ({
    id,
    name,
    default: preferred,
    icon,
  }));
}

/** One macOS handler with the grouping metadata the display list folds away. */
interface MacApplication extends NativeApplication {
  bundle: string | null;
  version: string | null;
}

/**
 * Ask LaunchServices about one file.
 *
 * `icons` asks the window server for a rendered 32px PNG per application, which
 * is the expensive half; the launch path re-asks without them, because a stale
 * id has to be refused against the *complete* registered list and that list is
 * cheaper to obtain than the icons are.
 */
async function queryMacApplications(
  absolutePath: string,
  internals: NativeInternals,
  icons: boolean,
): Promise<MacApplication[]> {
  const stdout = await run(internals)({
    command: "osascript",
    args: [
      "-l",
      "JavaScript",
      "-e",
      MAC_APPLICATIONS,
      absolutePath,
      icons ? "icons" : "handlers",
    ],
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  const text = stdout.trim();
  if (text === "") throw new Error("osascript returned no application list");
  return parseMacApplications(JSON.parse(text));
}

/**
 * Validate everything the query answered.
 *
 * The answer comes from this module's own script, so an entry that does not fit
 * means something else produced it — refused rather than half-read, the same
 * way dsh validates the decoded list.
 */
function parseMacApplications(value: unknown): MacApplication[] {
  if (!Array.isArray(value)) throw new Error("Invalid native application list");
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Invalid native application entry");
    }
    const record = entry as Record<string, unknown>;
    const { id, name, default: preferred, icon } = record;
    if (typeof id !== "string" || id === "" || typeof name !== "string") {
      throw new Error("Invalid native application entry");
    }
    if (typeof preferred !== "boolean") throw new Error("Invalid native application entry");
    if (icon !== null && !(typeof icon === "string" && icon.startsWith("data:image/png;base64,"))) {
      throw new Error("Invalid native application entry");
    }
    return {
      id,
      name,
      default: preferred,
      icon,
      bundle: optionalMacField(record.bundle),
      version: optionalMacField(record.version),
    };
  });
}

/** Read one optional string field; missing, null and empty all read as absent. */
function optionalMacField(field: unknown): string | null {
  if (field === null || field === undefined) return null;
  if (typeof field !== "string") throw new Error("Invalid native application entry");
  return field === "" ? null : field;
}

/**
 * Collapse duplicate registrations of one application for display.
 *
 * Self-updating apps leave extra copies on disk (an update staged under
 * Application Support, per-version installs) and LaunchServices registers every
 * one of them, so the raw list repeats the same app. Finder shows one entry per
 * app and only splits deliberate side-by-side installs, which carry distinct
 * display names; matching that, copies sharing a bundle id and display name
 * collapse to whichever the system defaults to, else to the highest version, at
 * the group's first position. Launching bypasses this collapse so every
 * registered copy stays openable.
 */
function dedupeMacApplications(applications: MacApplication[]): MacApplication[] {
  const order: MacApplication[] = [];
  const groups = new Map<string, number>();
  for (const app of applications) {
    if (app.bundle === null) {
      order.push(app);
      continue;
    }
    const key = `${app.bundle}\u0000${app.name}`;
    const index = groups.get(key);
    if (index === undefined) {
      groups.set(key, order.length);
      order.push(app);
      continue;
    }
    const held = order[index];
    if (held.default) continue;
    if (app.default || compareVersions(app.version, held.version) > 0) order[index] = app;
  }
  return order;
}

/**
 * Order two dotted version strings numerically.
 *
 * A segment that is not a number counts as 0 and a missing version sorts below
 * every present one, so a staged copy without a version never displaces an
 * installed one.
 */
function compareVersions(left: string | null, right: string | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (Number(a[i]) || 0) - (Number(b[i]) || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Open one file with the operating system's default application, or with the
 * default browser when the file is a document a browser renders.
 *
 * The browser preference exists because "default application" for a `.html` on
 * a machine where an editor claimed the extension is the editor, while the
 * gesture — show me the page — means the browser. dsh draws the line in the
 * same place; when no browser can be named, the association wins.
 */
export async function openFileWithDefault(
  absolutePath: string,
  internals: NativeInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform;
  const wsl = platform === "linux" && isWsl(internals);
  if (
    !wsl &&
    BROWSER_DOCUMENTS.has(extname(absolutePath).toLowerCase()) &&
    (await openInBrowser(absolutePath, internals))
  ) {
    return;
  }
  if (platform === "darwin") {
    await launch(["open", absolutePath], internals);
    return;
  }
  if (platform === "win32" || wsl) {
    await openWindowsPath(absolutePath, internals);
    return;
  }
  if (platform === "linux") {
    await launch(["xdg-open", absolutePath], internals);
    return;
  }
  throw new Error(`这台主机不支持用默认应用打开：${platform}`);
}

/**
 * Open one file with a named application, which is only offered where the
 * association list is: choosing among apps is what the list is for.
 */
export async function openFileWithApplication(
  absolutePath: string,
  application: string,
  internals: NativeInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(`这台主机不支持指定应用打开：${platform}`);
  // Against the full registered list, not the deduped one: a copy that was
  // folded away for display is still a real handler, and an id that is not
  // registered at all is not something to launch.
  const registered = await queryMacApplications(absolutePath, internals, false);
  if (!registered.some((app) => app.id === application)) {
    throw new Error("所选应用没有注册为这个文件的打开方式");
  }
  await launch(["open", "-a", application, absolutePath], internals);
}

/**
 * Reveal a file in Finder or Explorer, or open its directory through the Linux
 * desktop's own file manager.
 */
export async function revealFile(
  absolutePath: string,
  internals: NativeInternals = {},
): Promise<void> {
  const platform = internals.platform ?? process.platform;
  const manager = nativeFileManager({ ...internals, platform });
  if (manager === "finder") {
    await launch(["open", "-R", absolutePath], internals);
    return;
  }
  if (manager === "explorer") {
    let windowsPath = absolutePath;
    if (platform === "linux") {
      windowsPath = await translateWslPath(absolutePath, internals);
    }
    await runExplorer(["/select,", explorerTarget(windowsPath)], internals);
    return;
  }
  if (manager === "directory") {
    await launch(["xdg-open", dirname(absolutePath)], internals);
    return;
  }
  throw new Error(`这台主机没有可以显示文件位置的文件管理器：${platform}`);
}

/**
 * Which file-manager action this host has, or null when it has none.
 *
 * Named rather than guessed per call site: the shell command and the label the
 * user reads come from the same answer.
 */
function nativeFileManager(internals: NativeInternals): "finder" | "explorer" | "directory" | null {
  const platform = internals.platform ?? process.platform;
  if (platform === "darwin") return "finder";
  if (platform === "win32" || (platform === "linux" && isWsl(internals))) return "explorer";
  return platform === "linux" ? "directory" : null;
}

/** Open one path through the Windows shell, which owns association resolution. */
async function openWindowsPath(absolutePath: string, internals: NativeInternals): Promise<void> {
  const platform = internals.platform ?? process.platform;
  let windowsPath = absolutePath;
  if (platform === "linux") windowsPath = await translateWslPath(absolutePath, internals);
  await runExplorer([explorerTarget(windowsPath)], internals);
}

/** Translate a path for the Windows desktop reached from WSL. */
async function translateWslPath(
  absolutePath: string,
  internals: NativeInternals,
): Promise<string> {
  const stdout = await run(internals)({
    command: "wslpath",
    args: ["-w", absolutePath],
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  const windowsPath = stdout.replace(/[\r\n]+$/, "");
  if (windowsPath === "") throw new Error("wslpath returned no Windows path");
  return windowsPath;
}

/**
 * Encode one Windows path as the single argument Explorer can receive intact.
 *
 * Explorer parses its own command line and splits fields at commas and equals
 * signs, so a raw path loses everything after the first separator and the shell
 * opens a different target without reporting it; both separators are escaped.
 * Nothing else is: Explorer rejects percent-encoded non-ASCII in a file URI and
 * opens the user's Documents folder instead, while it resolves the literal
 * characters, so the non-ASCII escapes are decoded back and the ASCII ones
 * stand.
 */
function explorerTarget(windowsPath: string): string {
  const href = pathToFileURL(windowsPath, { windows: true }).href;
  // A run of escapes whose every byte starts above ASCII is one character.
  return href
    .replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped))
    .replaceAll(",", "%2C")
    .replaceAll("=", "%3D");
}

/**
 * Hand one target to Explorer, accepting its delegated-handoff exit code.
 *
 * Explorer exits 1 after passing the request to the desktop process already
 * running, so exit 1 means the shell took it. Every other failure still
 * rejects.
 */
async function runExplorer(args: string[], internals: NativeInternals): Promise<void> {
  try {
    await run(internals)({
      command: "explorer.exe",
      args,
      // Hiding this window would hide the folder window that is the answer.
      windowsHide: false,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof NativeCommandError) || error.code !== 1) throw error;
  }
}

/**
 * Open one browser-renderable document with the default browser.
 *
 * Answers whether a browser took it. macOS names one through the `https`
 * handler LaunchServices records; Linux follows `$BROWSER`, the portable
 * convention. Windows names no browser without reading the UserChoice
 * registry, and its `.html` association is the browser in the ordinary case.
 */
async function openInBrowser(
  absolutePath: string,
  internals: NativeInternals,
): Promise<boolean> {
  const platform = internals.platform ?? process.platform;
  if (platform === "darwin") {
    let bundle: string | undefined;
    try {
      const plist = await run(internals)({
        command: "defaults",
        args: ["read", "com.apple.LaunchServices/com.apple.launchservices.secure"],
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      bundle = macBundleForHttps(plist);
    } catch {
      // A fresh account never changed a default, so there is no record to read
      // and the content-type handler is the system's own choice anyway.
      return false;
    }
    if (bundle === undefined) return false;
    await launch(["open", "-b", bundle, absolutePath], internals);
    return true;
  }
  if (platform === "linux") {
    const browser = (internals.env ?? process.env).BROWSER;
    if (browser === undefined || browser === "") return false;
    await launch([browser, absolutePath], internals);
    return true;
  }
  return false;
}

/**
 * The macOS bundle registered for `https` — the default browser, as
 * LaunchServices records it.
 *
 * The nested version dictionary is stripped first because it carries its own
 * `LSHandlerRoleAll`, which is the browser registered for a *version* of the
 * scheme rather than the one in effect.
 */
function macBundleForHttps(plist: string): string | undefined {
  const stripped = plist.replace(/LSHandlerPreferredVersions\s*=\s*\{[^}]*\};/g, "");
  const block = /\{[^{}]*LSHandlerURLScheme\s*=\s*"?https"?;[^{}]*\}/.exec(stripped)?.[0];
  if (block === undefined) return undefined;
  return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(block)?.[1];
}

/**
 * Run one launch, with the program and its arguments kept separate.
 *
 * A `$BROWSER` value that carries arguments of its own is the browser's
 * business rather than this module's: the convention it comes from treats the
 * value as a program name.
 */
async function launch(argv: string[], internals: NativeInternals): Promise<void> {
  const [command, ...args] = argv as [string, ...string[]];
  await run(internals)({ command, args, timeoutMs: LAUNCH_TIMEOUT_MS });
}
