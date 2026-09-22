/**
 * pi's extensions, read and toggled through pi's own resource resolver.
 *
 * There is no RPC for this. A running session knows the extensions it loaded,
 * but only for the process that is already up, and the interesting question —
 * what *would* load the next time pi starts — is answered by the settings and
 * package files on disk. So this module resolves those files the same way pi
 * does: `DefaultPackageManager.resolve()` and `SettingsManager`, both from the
 * `pi-coding-agent` package this server already depends on.
 *
 * Reimplementing the walk instead would be the wrong kind of cheap. The rules
 * it would have to reproduce are not obvious — a package's `pi.extensions`
 * manifest layered with per-package filters, auto-discovered files under
 * `extensions/` combined with `+`/`-`/`!` override patterns, project scope
 * shadowing global for the same package — and a list that disagrees with what
 * pi actually loads is worse than no list. `pi config` writes those same
 * patterns for the same reason; the toggle below copies its encoding verbatim.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  ProjectTrustStore,
  SettingsManager,
  getAgentDir,
  type PackageSource,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { noProjectCwd } from "./config.ts";

/** One extension pi would consider loading. */
export interface ExtensionItem {
  /** The entry file (or directory) pi loads. Also the identity for toggling. */
  path: string;
  /** Short name for the row: file stem, directory name, or package name. */
  name: string;
  /** Where the entry came from, as pi reports it. */
  source: string;
  scope: "user" | "project";
  /**
   * `top-level` is an auto-discovered or settings-declared path; `package` is
   * one contributed by an installed pi package. They toggle through different
   * settings keys, so the distinction has to survive to the write path.
   */
  origin: "top-level" | "package";
  enabled: boolean;
}

export interface ExtensionsView {
  agentDir: string;
  /** pi's global settings file; the one the toggles write to for user scope. */
  settingsPath: string;
  /** Workspace the project scope was resolved against, when one was given. */
  projectPath: string | null;
  /** `<project>/.pi/settings.json`, or null when no workspace was given. */
  projectSettingsPath: string | null;
  /** pi gates project-local resources on this; the UI labels it. */
  projectTrusted: boolean;
  extensions: ExtensionItem[];
  /**
   * Resolution failure, reported instead of an empty list. A list that came
   * back empty because the resolver threw would read as "you have none".
   */
  error: string | null;
}

export class ExtensionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionConfigError";
  }
}

interface Resolved {
  cwd: string;
  agentDir: string;
  projectPath: string | null;
  projectTrusted: boolean;
  settingsManager: SettingsManager;
  resources: ResolvedResource[];
}

/**
 * Resolve extensions for one workspace, through pi's resolver.
 *
 * `onMissing` is deliberately `skip`: opening a settings page must not install
 * anything. A package that is configured but not on disk is simply absent from
 * the list, which is the truth about what the next pi start would load.
 */
async function resolveExtensions(projectPath: string | null): Promise<Resolved> {
  const agentDir = getAgentDir();
  const cwd = projectPath ?? noProjectCwd();
  const projectTrusted =
    projectPath !== null && new ProjectTrustStore(agentDir).get(projectPath) === true;

  // Resolve against the files as they are, regardless of trust: the point of
  // this page is to show what is on disk. Trust is reported separately rather
  // than silently dropping rows the user can see in their own directory.
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packages.resolve(async () => "skip");

  return {
    cwd,
    agentDir,
    projectPath,
    projectTrusted,
    settingsManager,
    resources: resolved.extensions,
  };
}

const INDEX_FILE = /^index\.(?:[cm]?[jt]s)$/;
const TS_EXTENSION = /\.(?:[cm]?[jt]s)$/;

/**
 * A short, stable label for a row.
 *
 * `index.ts` inside a directory is the conventional entry point, so the useful
 * name is the directory's, not the file's — `my-extension`, not `index`.
 */
function extensionName(path: string): string {
  const file = basename(path);
  if (INDEX_FILE.test(file)) return basename(dirname(path));
  return file.replace(TS_EXTENSION, "");
}

/** `npm:@scope/pkg@1.0.0` → `@scope/pkg`, `git:host/user/repo@v1` → `user/repo`. */
function sourceLabel(source: string): string {
  const withoutScheme = source.replace(/^(?:npm|git):/, "");
  const withoutRef = withoutScheme.replace(/@[\w.\-/]+$/, "");
  return withoutRef.split("/").filter(Boolean).join("/") || source;
}

/**
 * The name a package calls itself, which is friendlier than its install path.
 *
 * `metadata.source` identifies a package well enough for npm and git, but a
 * local package is recorded as the directory it lives in — which is often a
 * scratch path, not the package's name. Returns null when there is nothing
 * readable, in which case the caller falls back to the source string.
 */
async function readPackageName(baseDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(baseDir, "package.json"), "utf8"));
    return typeof parsed?.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

function toItem(
  resource: ResolvedResource,
  packageName: string | null,
  packageEntries: number,
): ExtensionItem {
  const { metadata } = resource;
  if (metadata.origin !== "package") {
    return {
      path: resource.path,
      name: extensionName(resource.path),
      source: metadata.source,
      // `temporary` only exists for `-e` runs, which never reach settings.
      scope: metadata.scope === "project" ? "project" : "user",
      origin: "top-level",
      enabled: resource.enabled,
    };
  }

  // A package with several entry points needs the paths to tell them apart;
  // the package name alone would render identical rows.
  const label = packageName ?? sourceLabel(metadata.source);
  return {
    path: resource.path,
    name:
      packageEntries > 1
        ? `${label}/${relative(metadata.baseDir ?? dirname(resource.path), resource.path)}`
        : label,
    source: metadata.source,
    scope: metadata.scope === "project" ? "project" : "user",
    origin: "package",
    enabled: resource.enabled,
  };
}

/** pi's global settings file. Resolved per call: tests repoint the agent dir. */
function globalSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

async function toView(resolved: Resolved, error: string | null): Promise<ExtensionsView> {
  // Each package is asked for its name once, and counted once: the label for a
  // multi-entry package carries the relative path, which needs both.
  const packageDirs = new Set(
    resolved.resources
      .filter((resource) => resource.metadata.origin === "package")
      .map((resource) => resource.metadata.baseDir ?? dirname(resource.path)),
  );
  const names = new Map<string, string | null>();
  const counts = new Map<string, number>();
  for (const resource of resolved.resources) {
    if (resource.metadata.origin !== "package") continue;
    const baseDir = resource.metadata.baseDir ?? dirname(resource.path);
    counts.set(baseDir, (counts.get(baseDir) ?? 0) + 1);
  }
  await Promise.all(
    [...packageDirs].map(async (baseDir) => {
      names.set(baseDir, await readPackageName(baseDir));
    }),
  );

  const extensions = resolved.resources.map((resource) => {
    const baseDir = resource.metadata.baseDir ?? dirname(resource.path);
    return toItem(resource, names.get(baseDir) ?? null, counts.get(baseDir) ?? 1);
  });

  return {
    agentDir: resolved.agentDir,
    settingsPath: globalSettingsPath(resolved.agentDir),
    projectPath: resolved.projectPath,
    projectSettingsPath:
      resolved.projectPath === null ? null : projectSettingsPath(resolved.cwd),
    projectTrusted: resolved.projectTrusted,
    extensions: extensions.sort(compareItems),
    error,
  };
}

/**
 * User scope first, then project; inside a scope the resolver's own order,
 * which already puts packages before auto-discovered files. Sorting by name
 * instead would make two machines with the same set disagree, and would move
 * rows under the user while they are looking at them.
 */
function compareItems(left: ExtensionItem, right: ExtensionItem): number {
  if (left.scope !== right.scope) return left.scope === "user" ? -1 : 1;
  return 0;
}

/** Read the extension inventory. Never throws for a bad package; reports it. */
export async function readExtensions(projectPath: string | null): Promise<ExtensionsView> {
  try {
    return await toView(await resolveExtensions(projectPath), null);
  } catch (err) {
    const agentDir = getAgentDir();
    return {
      agentDir,
      settingsPath: globalSettingsPath(agentDir),
      projectPath,
      projectSettingsPath: projectPath === null ? null : projectSettingsPath(projectPath),
      projectTrusted: false,
      extensions: [],
      error: (err as Error).message,
    };
  }
}

export interface ExtensionStateInput {
  /** Workspace the row was listed under; null for the global list. */
  projectPath: string | null;
  path: string;
  enabled: boolean;
}

/**
 * Enable or disable one extension by writing pi's override pattern.
 *
 * The encoding is `pi config`'s (see its `toggleTopLevelResource` /
 * `togglePackageResource`): a top-level entry appends `${"+"|"-"}<path relative
 * to the scope base dir>` to that scope's `extensions` array, and a package
 * entry does the same inside the package's object form. Existing patterns for
 * the same path are replaced rather than stacked, so toggling twice does not
 * leave a `-` and a `+` fighting over one file.
 *
 * Writing through `SettingsManager` rather than the file keeps pi's own field
 * bookkeeping, project-trust guard, and write queue in play; re-encoding the
 * JSON here would be a second implementation of a format pi owns.
 */
export async function setExtensionEnabled(input: ExtensionStateInput): Promise<ExtensionsView> {
  const resolved = await resolveExtensions(input.projectPath);
  const target = resolved.resources.find((resource) => resource.path === input.path);
  if (target === undefined) {
    throw new ExtensionConfigError(`没有找到扩展 ${input.path}。`);
  }
  if (target.metadata.scope === "project" && !resolved.projectTrusted) {
    throw new ExtensionConfigError("这个工作区尚未被信任，无法改写它的 .pi 设置。");
  }

  const baseDir =
    target.metadata.baseDir ??
    (target.metadata.scope === "project"
      ? join(resolved.cwd, CONFIG_DIR_NAME)
      : resolved.agentDir);
  const pattern = relative(baseDir, target.path);
  const settings = resolved.settingsManager;

  if (target.metadata.origin === "package") {
    const packages = [...settings.getPackages()];
    const index = packages.findIndex(
      (entry) => (typeof entry === "string" ? entry : entry.source) === target.metadata.source,
    );
    if (index === -1) {
      throw new ExtensionConfigError(`没有找到包 ${target.metadata.source}。`);
    }
    const updated = withPackageOverride(packages, index, pattern, input.enabled);
    if (target.metadata.scope === "project") settings.setProjectPackages(updated);
    else settings.setPackages(updated);
  } else {
    const current =
      target.metadata.scope === "project"
        ? settings.getProjectSettings().extensions ?? []
        : settings.getGlobalSettings().extensions ?? [];
    const updated = withOverride(current, pattern, input.enabled);
    if (target.metadata.scope === "project") settings.setProjectExtensionPaths(updated);
    else settings.setExtensionPaths(updated);
  }

  await settings.flush();
  return await toView(await resolveExtensions(input.projectPath), null);
}

/**
 * Install one pi package through pi's own package manager.
 *
 * This is the same operation `pi install <source>` performs: the package lands
 * in the agent dir's npm root and the source is recorded in pi's settings, so
 * the terminal and this server agree afterwards on what is installed. It is
 * slow by nature — npm has to resolve and download — which is why every caller
 * keeps a progress state rather than a spinner with no explanation.
 *
 * Install only; nothing is enabled here. A freshly installed package is picked
 * up by the next pi process (see the callers that retire the resident ones).
 */
export async function installPackage(source: string): Promise<void> {
  const agentDir = getAgentDir();
  const cwd = noProjectCwd();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  await packages.installAndPersist(source);
}

/**
 * Append the override for one path, dropping any earlier pattern that named the
 * same one. Copied from `pi config` so both writers agree byte for byte on what
 * "enabled" looks like in the file.
 */
function withOverride(patterns: string[], pattern: string, enabled: boolean): string[] {
  const updated = patterns.filter((entry) => {
    const stripped = /^[!+-]/.test(entry) ? entry.slice(1) : entry;
    return stripped !== pattern;
  });
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  return updated;
}

/**
 * Same, inside a package entry — converting the string form to the object form
 * when it is the first filter that package has needed.
 *
 * The caller decides which array the result goes back into (global or project)
 * before calling; a project entry with `autoload: false` is a delta over the
 * global one, so it must be edited where it was configured.
 */
function withPackageOverride(
  packages: PackageSource[],
  index: number,
  pattern: string,
  enabled: boolean,
): PackageSource[] {
  const entry = packages[index]!;
  const object = typeof entry === "string" ? { source: entry } : { ...entry };
  object.extensions = withOverride(object.extensions ?? [], pattern, enabled);

  // A package with no filters left goes back to the string form, matching what
  // `pi config` leaves behind and keeping hand-edited files readable.
  const hasFilters = (["extensions", "skills", "prompts", "themes"] as const).some(
    (resourceKey) => object[resourceKey] !== undefined && object[resourceKey]!.length > 0,
  );
  const next: PackageSource[] = [...packages];
  next[index] = hasFilters || object.autoload === false ? object : object.source;
  return next;
}
