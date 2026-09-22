/**
 * Update notices: whether a newer pi is published, and which installed pi
 * packages are behind their upstream.
 *
 * Two different facts, resolved two different ways, because they are not the
 * same kind of thing.
 *
 * **pi itself** is an npm dependency of this server (`@earendil-works/pi-coding-agent`),
 * and what a newer release *is* is answered by pi's own release endpoint —
 * `https://pi.dev/api/latest-version`, the same one the CLI polls at startup.
 * Reimplementing that check against the npm registry would report versions pi
 * never announced (deprecations, yanked publishes, prerelease churn), so the
 * same endpoint is used and only the comparison is ours.
 *
 * **Extensions** are pi packages, and pi already knows how to ask whether a
 * configured source is behind: `DefaultPackageManager.checkForAvailableUpdates()`.
 * It filters out exactly what cannot be compared — local paths, version-pinned
 * sources, missing installs — and honors `PI_OFFLINE`. That knowledge lives in
 * pi, not here, so it is called rather than reproduced.
 *
 * The check is cached in memory: opening the settings page should not spawn an
 * `npm view` per package every time, and pi itself polls at most once per start.
 * An explicit refresh (`force`) bypasses the cache.
 */

import {
  DefaultPackageManager,
  SettingsManager,
  VERSION,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { noProjectCwd } from "./config.ts";

/** pi's release endpoint, as used by the CLI's own startup check. */
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const VERSION_CHECK_TIMEOUT_MS = 10 * 1000;

/** The package this server depends on, for the "how to update" line. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** What actually moves this server to a newer pi: its own lockfile. */
const PI_UPDATE_COMMAND = `pnpm update ${PI_PACKAGE}`;

/** How long a resolved answer is reused before the network is asked again. */
export const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface PiVersionInfo {
  /** The pi this server is running (`VERSION` from the package it imported). */
  current: string;
  /** Newest announced release, or null when it could not be determined. */
  latest: string | null;
  available: boolean;
  /** Optional release note published alongside the version. */
  note: string | null;
  /** The package name the release belongs to, when the endpoint reports one. */
  packageName: string;
  /** The command that updates *this server's* pi, shown with the notice. */
  updateCommand: string;
  /**
   * Why the check produced no answer. Kept apart from `available: false` so
   * the page can say "could not check" instead of claiming "up to date" — the
   * two are not the same fact and only one of them is good news.
   */
  error: string | null;
  /** The check was deliberately skipped (`PI_OFFLINE` / `PI_SKIP_VERSION_CHECK`). */
  skipped: boolean;
}

/** One installed package pi reports as behind its upstream. */
export interface ExtensionUpdate {
  /** The source string as pi's settings record it; matches `ExtensionItem.source`. */
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

export interface UpdatesView {
  pi: PiVersionInfo;
  /** Packages with an available update; empty when there are none. */
  extensions: ExtensionUpdate[];
  /** Why the package check produced no list. Same rule as `pi.error`. */
  extensionsError: string | null;
  /** When this answer was resolved (epoch ms), so the page can age it. */
  checkedAt: number;
}

/**
 * The slice of pi's package manager this module uses.
 *
 * Stated structurally rather than as `DefaultPackageManager` so a test can
 * stand in for it without spawning `npm view`, which is what the real one does.
 */
export interface PackageUpdateSource {
  checkForAvailableUpdates(): Promise<
    readonly { source: string; displayName: string; type: "npm" | "git"; scope: string }[]
  >;
  update(source?: string): Promise<void>;
}

/** Injection points for the two things that leave this process. */
export interface UpdatesDeps {
  /** Defaults to the global fetch; tests replace it so nothing goes out. */
  fetchImpl?: typeof fetch;
  /** Defaults to pi's own package manager; tests replace the network side. */
  packageManager?: (projectPath: string | null) => PackageUpdateSource;
}

export class UpdatesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdatesConfigError";
  }
}

// --- version comparison ------------------------------------------------------

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  numbers: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/**
 * Semver ordering, minus build metadata. Returns null when either side is not a
 * version this can order — callers treat that as "no answer" rather than as
 * "equal", because a release tag like `nightly` must not be announced as newer.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;

  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! - b.numbers[i]!;
  }

  // A release outranks any prerelease of the same version (`1.0.0` > `1.0.0-rc.1`).
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A shorter prerelease list sorts first (`1.0.0-alpha` < `1.0.0-alpha.1`).
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return Number(x) - Number(y);
    // Numeric identifiers always sort below alphanumeric ones.
    if (numericX) return -1;
    if (numericY) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True only when `candidate` is a strictly newer, parseable version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const comparison = compareVersions(candidate, current);
  return comparison !== null && comparison > 0;
}

// --- environment switches ----------------------------------------------------

/** pi's own offline switch, recognized exactly the way pi recognizes it. */
function offlineModeEnabled(): boolean {
  const value = process.env.PI_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** `PI_SKIP_VERSION_CHECK` disables pi's own startup check; this respects it too. */
function versionCheckSkipped(): boolean {
  return offlineModeEnabled() || Boolean(process.env.PI_SKIP_VERSION_CHECK);
}

/**
 * pi's User-Agent shape (`pi/<version> (<platform>; <runtime>; <arch>)`), copied
 * so the release endpoint sees this check the way it sees the CLI's.
 */
function userAgent(version: string): string {
  const runtime = process.versions.bun
    ? `bun/${process.versions.bun}`
    : `node/${process.version}`;
  return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

/** Node hides errno detail behind "fetch failed"; dig it back out for the page. */
function describeFetchError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") {
    return `请求超时（${Math.round(VERSION_CHECK_TIMEOUT_MS / 1000)} 秒）。`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
  const codes = causes
    .map((value) =>
      typeof value === "object" && value !== null && "code" in value
        ? String((value as { code: unknown }).code)
        : "",
    )
    .filter((code) => code.length > 0);
  return codes.length > 0 ? `${message} (${[...new Set(codes)].join(", ")})` : message;
}

// --- pi's own release --------------------------------------------------------

interface LatestRelease {
  version: string;
  packageName: string;
  note: string | null;
}

/**
 * Ask pi's release endpoint for the newest version. Returns null when the
 * endpoint answers 200 with nothing usable; throws when it cannot be reached,
 * so the caller can tell "no announced release" from "could not ask".
 */
async function fetchLatestRelease(
  current: string,
  fetchImpl: typeof fetch,
): Promise<LatestRelease | null> {
  const response = await fetchImpl(LATEST_VERSION_URL, {
    headers: { "User-Agent": userAgent(current), accept: "application/json" },
    signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.version !== "string" || data.version.trim().length === 0) return null;
  const packageName =
    typeof data.packageName === "string" && data.packageName.trim().length > 0
      ? data.packageName.trim()
      : PI_PACKAGE;
  const note =
    typeof data.note === "string" && data.note.trim().length > 0 ? data.note.trim() : null;
  return { version: data.version.trim(), packageName, note };
}

/** Resolve pi's version notice. Never throws; failures land in `error`. */
async function readPiVersion(deps: UpdatesDeps): Promise<PiVersionInfo> {
  const current = VERSION;
  const base = {
    current,
    latest: null,
    available: false,
    note: null,
    packageName: PI_PACKAGE,
    updateCommand: PI_UPDATE_COMMAND,
  } satisfies Omit<PiVersionInfo, "error" | "skipped">;

  if (versionCheckSkipped()) {
    return { ...base, error: null, skipped: true };
  }

  try {
    const release = await fetchLatestRelease(current, deps.fetchImpl ?? fetch);
    if (release === null) {
      return { ...base, error: "版本服务没有返回可用的版本号。", skipped: false };
    }
    return {
      ...base,
      latest: release.version,
      available: isNewerVersion(release.version, current),
      note: release.note,
      packageName: release.packageName,
      error: null,
      skipped: false,
    };
  } catch (err) {
    return { ...base, error: describeFetchError(err), skipped: false };
  }
}

// --- installed package updates ----------------------------------------------

/**
 * The package manager input for one workspace, matching what `extensions.ts`
 * builds: resolution runs against the files as they are, regardless of trust,
 * because this page reports what is on disk rather than what would load.
 */
function defaultPackageManager(projectPath: string | null): PackageUpdateSource {
  const agentDir = getAgentDir();
  const cwd = projectPath ?? noProjectCwd();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

/** One package manager per call: it holds no state worth reusing across calls. */
async function readExtensionUpdates(
  projectPath: string | null,
  deps: UpdatesDeps,
): Promise<{ items: ExtensionUpdate[]; error: string | null }> {
  try {
    const packages = (deps.packageManager ?? defaultPackageManager)(projectPath);
    const updates = await packages.checkForAvailableUpdates();
    return {
      items: updates.map((update) => ({
        source: update.source,
        displayName: update.displayName,
        type: update.type,
        scope: update.scope === "project" ? "project" : "user",
      })),
      error: null,
    };
  } catch (err) {
    return { items: [], error: (err as Error).message };
  }
}

// --- cache -------------------------------------------------------------------

const cache = new Map<string, { at: number; value: UpdatesView }>();

/** Test seam and write-path invalidation: the next read asks upstream again. */
export function clearUpdateCache(): void {
  cache.clear();
}

/**
 * Resolve both notices for one workspace.
 *
 * `projectPath` selects which scope's packages are checked — a project-local
 * package can be behind while the global ones are current, and the plugins page
 * shows both. The cache is keyed by that path so two workspaces do not answer
 * for each other.
 */
export async function readUpdates(
  projectPath: string | null,
  options: { force?: boolean; deps?: UpdatesDeps } = {},
): Promise<UpdatesView> {
  const key = projectPath ?? "";
  const now = Date.now();
  const cached = cache.get(key);
  if (options.force !== true && cached !== undefined && now - cached.at < UPDATE_CACHE_TTL_MS) {
    return cached.value;
  }

  const deps = options.deps ?? {};
  const [pi, extensions] = await Promise.all([
    readPiVersion(deps),
    readExtensionUpdates(projectPath, deps),
  ]);
  const value: UpdatesView = {
    pi,
    extensions: extensions.items,
    extensionsError: extensions.error,
    checkedAt: now,
  };
  cache.set(key, { at: now, value });
  return value;
}

/**
 * Move one installed package to its upstream version, through pi's own package
 * manager — the same operation `pi update <source>` performs.
 *
 * Only packages pi can compare are offered in the first place, so a source that
 * cannot be updated never reaches here. The cache is dropped afterwards because
 * the answer it holds is now stale by construction.
 */
export async function updateExtension(
  projectPath: string | null,
  source: string,
  options: { deps?: UpdatesDeps } = {},
): Promise<UpdatesView> {
  const deps = options.deps ?? {};
  try {
    const packages = (deps.packageManager ?? defaultPackageManager)(projectPath);
    await packages.update(source);
  } catch (err) {
    throw new UpdatesConfigError(`更新 ${source} 失败：${(err as Error).message}`);
  }
  clearUpdateCache();
  return await readUpdates(projectPath, { force: true, deps });
}
