/**
 * The task-list extension, and whether the next pi start would load it.
 *
 * pi's `todo` tool is not built in: it ships with `@juicesharp/rpiv-todo`, a
 * package the user installs. Everything the todo panel shows is a projection of
 * that tool's transcript output (see `web/src/features/conversation/todo-model.ts`),
 * so when the extension is absent the panel has nothing to project — and the
 * honest thing to render is the missing piece, not an empty list.
 *
 * The check goes through `readExtensions`, which resolves packages with pi's
 * own manager: a package that is configured but disabled does not count as
 * available, and one that is configured but missing from disk never appears at
 * all. That is the same question the MCP section asks of `pi-mcp-adapter`.
 */

import { installPackage, readExtensions } from "./extensions.ts";

/** The package that contributes pi's `todo` tool. */
export const TODO_PACKAGE = "@juicesharp/rpiv-todo";
/** What the install button runs under the hood, for people who use the CLI. */
export const TODO_SOURCE = `npm:${TODO_PACKAGE}`;

export interface TodoView {
  /** True when pi would load the extension on the next start. */
  available: boolean;
  /** True when pi's settings reference the package at all, even disabled. */
  installed: boolean;
  packageName: string;
  source: string;
  /** Workspace the check was resolved against; null is the user scope only. */
  projectPath: string | null;
  /**
   * Resolution failure. The UI keeps the notice hidden in this case rather
   * than offering to install something that may already be installed — a read
   * that broke is not a missing package.
   */
  error: string | null;
}

export class TodoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoConfigError";
  }
}

/**
 * `npm:@scope/pkg@1.0.0` → `@scope/pkg`, `npm:pkg` → `pkg`.
 *
 * A trailing `@version` is stripped, but only when the `@` is not the leading
 * scope marker: `lastIndexOf("@")` is 0 for `@scope/pkg`, which must be kept.
 */
function packageNameOf(source: string): string {
  const withoutScheme = source.replace(/^(?:npm|git):/, "");
  const at = withoutScheme.lastIndexOf("@");
  return at > 0 ? withoutScheme.slice(0, at) : withoutScheme;
}

/**
 * Does this resolved row come from the todo package?
 *
 * A package with several entry points labels each row `<pkg>/<relative path>`,
 * so the bare package name only matches the single-entry case — the source
 * matches either way once its scheme and version pin are stripped.
 */
function fromTodoPackage(entry: { name: string; source: string }): boolean {
  return entry.name === TODO_PACKAGE || packageNameOf(entry.source) === TODO_PACKAGE;
}

/** Read whether the task-list extension is in place. Never throws. */
export async function readTodo(projectPath: string | null): Promise<TodoView> {
  const view = await readExtensions(projectPath);
  const entries = view.extensions.filter(fromTodoPackage);
  return {
    available: entries.some((entry) => entry.enabled),
    installed: entries.length > 0,
    packageName: TODO_PACKAGE,
    source: TODO_SOURCE,
    projectPath,
    error: view.error,
  };
}

/**
 * Install the task-list extension through pi's own package manager.
 *
 * The same operation as `pi install npm:@juicesharp/rpiv-todo`. Installing is
 * not instant, so the caller shows progress; a failure is not cached anywhere,
 * and a successful install is visible to the next pi process the moment this
 * server retires the resident ones.
 */
export async function installTodoExtension(projectPath: string | null): Promise<TodoView> {
  const existing = await readTodo(projectPath);
  if (existing.available) return existing;

  try {
    await installPackage(TODO_SOURCE);
  } catch (err) {
    throw new TodoConfigError(`安装 ${TODO_SOURCE} 失败：${(err as Error).message}`);
  }

  const view = await readTodo(projectPath);
  if (!view.available) {
    // Saying so matters: the install itself reported success, so pressing the
    // button again will not help. This is the state where the package is in
    // settings but still contributes no loadable extension.
    throw new TodoConfigError(
      `已安装 ${TODO_SOURCE}，但 pi 仍然看不到它的扩展入口；请检查这个包是否提供 pi.extensions。`,
    );
  }
  return view;
}
