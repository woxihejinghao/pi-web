import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { ExtensionItem, ExtensionUpdate } from "../../lib/types.ts";
import { extensionUpdateCount, updateForSource } from "../../lib/updates.ts";
import { shouldOfferTodoInstall } from "../conversation/todo-model.ts";
import { extensionSourceLabel, groupExtensions, groupMeta } from "./plugin-model.ts";
import styles from "./PluginsSection.module.css";

/**
 * The plugins section, ported from dsh's `settings-plugins` section and its
 * `settings-plugin-inventory` tab.
 *
 * What differs is what a plugin *is*. dsh lists cordis plugins with a scope
 * (global vs. per-session agent preset), a live fiber phase, and a declared
 * entry id; its inventory tab is read-only because writing enablement back is
 * the preset editor's job. pi's unit is the *extension*: a TypeScript module
 * pi loads at startup, contributed either by a local path or by an installed
 * pi package. It has no runtime phase to report — it is either in the process
 * or it is not — and enablement is a setting `pi config` already owns, so the
 * rows here are togglable rather than inert.
 *
 * Two things are deliberately absent:
 *
 * - **No "运行状态" column.** dsh's plugin has a lifecycle (loading, waiting on
 *   dependencies, running, unloading) that its host can observe. An extension
 *   is loaded synchronously into whatever pi processes are alive; the honest
 *   answer would be "running in 2 of the 3 open sessions", which the page has
 *   no cheap way to know and which would change between renders. The health of
 *   a broken extension surfaces as an `extension_error` event in the session,
 *   where it actually happened.
 * - **No package configuration cards.** dsh's second tab renders one card per
 *   settings namespace a host plugin serves. pi's extensions declare no such
 *   schema — what they read lives in the extension's own code — so there is
 *   nothing to build a form from. Showing a tab with no cards would be worse
 *   than not showing the tab.
 */

type Scope = "user" | "project";

export function PluginsSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<Scope, boolean>>({
    user: false,
    project: false,
  });
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  /** Paths with a toggle in flight, so the switch can show it is working. */
  const [pending, setPending] = useState<Record<string, true>>({});
  /** Paths with an update in flight, so its row can show the same. */
  const [updating, setUpdating] = useState<Record<string, true>>({});
  /** Why an update failed, per path — shown in the row that started it. */
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});
  /** The task-list extension's install offer, which lives below the lead. */
  const [installingTodo, setInstallingTodo] = useState(false);
  const [todoError, setTodoError] = useState<string | null>(null);
  /** A forced update check in flight, from the header's 检查更新. */
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const projectPath =
    state.projects.find((project) => project.id === state.selectedProjectId)?.path ?? null;

  const view = state.extensions;
  const todo = state.todo;
  // Same slot the 关于 row in 通用设置 writes, keyed by workspace.
  const updates = state.updates[projectPath ?? ""] ?? null;
  const updateCount = extensionUpdateCount(updates);

  useEffect(() => {
    // The inventory depends on the workspace, so switching workspaces has to
    // re-resolve rather than keep showing the previous one's .pi entries.
    if (view !== null && view.projectPath === projectPath) return;
    void actions.loadExtensions(projectPath);
  }, [projectPath, view]);

  useEffect(() => {
    // Which packages are behind is resolved per workspace too, and the server
    // caches it — a visit only asks when this workspace has no answer yet.
    if (updates !== null) return;
    void actions.loadUpdates(projectPath);
  }, [projectPath, updates]);

  useEffect(() => {
    // Same rule for the task-list answer: it is resolved per workspace, and it
    // is what decides whether the install offer below is worth showing.
    if (todo !== null && todo.projectPath === projectPath) return;
    void actions.loadTodo(projectPath);
  }, [projectPath, todo]);

  const installTodo = (): void => {
    setInstallingTodo(true);
    setTodoError(null);
    void actions
      .installTodoExtension(projectPath)
      .catch((err: Error) => setTodoError(err.message))
      .finally(() => setInstallingTodo(false));
  };

  /**
   * Ask upstream again. The server caches its answer for a few minutes, so
   * someone who just updated a package in a terminal would otherwise keep
   * seeing the old notice.
   */
  const refreshUpdates = (): void => {
    setCheckingUpdates(true);
    void actions.loadUpdates(projectPath, { force: true }).finally(() => setCheckingUpdates(false));
  };

  const groups = useMemo(() => groupExtensions(view, query), [view, query]);
  // A search that matched only the folded group should not look like no result.
  const searching = query.trim().length > 0;
  const total = view?.extensions.length ?? 0;
  const matched = groups.user.length + groups.project.length;

  const toggle = (scope: Scope): void => {
    setCollapsed((previous) => ({ ...previous, [scope]: !previous[scope] }));
  };

  const setEnabled = (item: ExtensionItem, enabled: boolean): void => {
    if (pending[item.path]) return;
    setPending((previous) => ({ ...previous, [item.path]: true }));
    void actions
      .setExtensionEnabled(projectPath, item, enabled)
      .finally(() => {
        setPending((previous) => {
          const next = { ...previous };
          delete next[item.path];
          return next;
        });
      });
  };

  /**
   * Move one package to its upstream version. Rethrows nothing: the failure is
   * kept on the row, which is where the button that caused it lives.
   */
  const runUpdate = (item: ExtensionItem): void => {
    if (updating[item.path]) return;
    setUpdating((previous) => ({ ...previous, [item.path]: true }));
    setUpdateErrors((previous) => {
      const next = { ...previous };
      delete next[item.path];
      return next;
    });
    void actions
      .updateExtension(projectPath, item.source)
      .then(() => actions.setNotice(t("settings.plugins.updated", { name: item.name })))
      .catch((err: Error) => {
        setUpdateErrors((previous) => ({ ...previous, [item.path]: err.message }));
      })
      .finally(() => {
        setUpdating((previous) => {
          const next = { ...previous };
          delete next[item.path];
          return next;
        });
      });
  };

  return (
    <div className={className}>
      <div className={styles.header}>
        <h1 className={styles.heading}>{t("settings.nav.plugins")}</h1>
        {/*
          dsh's header action opens the deployment's config file. That file is
          per-deployment there; here there are two (global settings and the
          workspace's `.pi/settings.json`), and a browser cannot hand either to
          the OS. Copying the global path is the same narrowing the models
          section makes, and the label says so.
        */}
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.configPath}
            disabled={checkingUpdates}
            title={t("settings.plugins.checkUpdatesTitle")}
            onClick={refreshUpdates}
          >
            {checkingUpdates ? t("settings.updates.checking") : t("settings.updates.check")}
          </button>
          <button
            type="button"
            className={styles.configPath}
            title={view?.settingsPath}
            disabled={view === null}
            onClick={() => {
              if (view === null) return;
              void navigator.clipboard
                .writeText(view.settingsPath)
                .then(() => actions.setNotice(t("settings.plugins.copyNotice", { path: view.settingsPath })))
                .catch(() => actions.setNotice(view.settingsPath));
            }}
          >{t("settings.models.copyPath")}</button>
        </div>
      </div>

      <p className={styles.lead}>{t("settings.plugins.lead")}</p>

      {/*
        The task panel's own notice can be closed, so the offer has to exist
        somewhere that is not a transient hint — this is that place, and it is
        also where anyone looking for "extensions" would come. The rule for
        when it is worth showing is the one the panel uses, minus the dismissal:
        an installed-but-disabled package is the user's own choice, not a
        missing dependency.
      */}
      {shouldOfferTodoInstall(todo, false) ? (
        <div className={styles.todoNotice}>
          <p className={styles.todoNoticeText}>{t("settings.plugins.todoNoticePrefix")}<code>todo</code>{t("settings.plugins.todoNoticeSuffix")}</p>
          <button
            type="button"
            className={styles.todoNoticeAction}
            disabled={installingTodo}
            title="pi install npm:@juicesharp/rpiv-todo"
            onClick={installTodo}
          >
            {installingTodo ? t("todo.installing") : t("todo.install")}
          </button>
          {todoError !== null ? <p className={styles.todoNoticeError}>{todoError}</p> : null}
        </div>
      ) : null}

      {/*
        The fact the 关于 row in 通用设置 counts, restated where the action is.
        Updates are per package — each one moves on its own — so this directs to
        the rows rather than offering a bulk button that would have to guess.
      */}
      {updateCount > 0 ? (
        <div className={styles.updateNotice}>
          <p className={styles.updateNoticeText}>
            {t("settings.plugins.updatesSummary", { count: updateCount })}
          </p>
        </div>
      ) : null}

      <div className={styles.search}>
        <Glyph name="search" size={16} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          type="search"
          value={query}
          placeholder={t("settings.plugins.searchPlaceholder")}
          aria-label={t("settings.plugins.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {view === null ? (
        <div className={styles.placeholder}>{t("settings.plugins.loading")}</div>
      ) : view.error !== null ? (
        <div className={styles.failure}>
          <p className={styles.failureText}>{t("settings.plugins.failed")}</p>
          <p className={styles.failureDetail}>{view.error}</p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void actions.loadExtensions(projectPath)}
          >{t("common.retry")}</button>
        </div>
      ) : total === 0 ? (
        <div className={styles.placeholder}>{t("settings.plugins.empty")}</div>
      ) : searching && matched === 0 ? (
        <div className={styles.placeholder}>{t("settings.plugins.noMatch")}</div>
      ) : (
        <>
          {(["user", "project"] as const).map((scope) => {
            const items = groups[scope];
            // The workspace group only exists when a workspace was resolved and
            // it contributed something. An empty heading would say "this
            // workspace has none" about a workspace that was never looked at.
            if (scope === "project" && (view.projectPath === null || items.length === 0)) {
              return null;
            }
            if (searching && items.length === 0) return null;

            return (
              <section key={scope} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-expanded={!collapsed[scope]}
                  onClick={() => toggle(scope)}
                >
                  <Glyph
                    name="chevronDown"
                    size={14}
                    className={clsx(
                      styles.groupChevron,
                      collapsed[scope] && styles.groupChevronCollapsed,
                    )}
                  />
                  <span className={styles.groupTitle}>{groupMeta(t)[scope].title}</span>
                  <span className={styles.groupSub}>{groupMeta(t)[scope].subtitle}</span>
                  <span className={styles.groupCount}>{t("settings.plugins.groupCount", { count: items.length })}</span>
                </button>

                {scope === "project" && !view.projectTrusted ? (
                  <p className={styles.note}>{t("settings.plugins.untrusted")}</p>
                ) : null}

                {!collapsed[scope] || searching ? (
                  <div className={styles.cards}>
                    {items.map((item) => (
                      <PluginCard
                        key={item.path}
                        item={item}
                        update={updateForSource(updates, item.source)}
                        updating={updating[item.path] === true}
                        updateError={updateErrors[item.path] ?? null}
                        expanded={expanded[item.path] === true}
                        pending={pending[item.path] === true}
                        togglable={item.scope === "user" || view.projectTrusted}
                        onToggle={() =>
                          setExpanded((previous) => {
                            const next = { ...previous };
                            if (next[item.path]) delete next[item.path];
                            else next[item.path] = true;
                            return next;
                          })
                        }
                        onSetEnabled={(enabled) => setEnabled(item, enabled)}
                        onUpdate={() => runUpdate(item)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function PluginCard({
  item,
  update,
  updating,
  updateError,
  expanded,
  pending,
  togglable,
  onToggle,
  onSetEnabled,
  onUpdate,
}: {
  item: ExtensionItem;
  /** pi's own "this package is behind" row, or null when it is current. */
  update: ExtensionUpdate | null;
  updating: boolean;
  /** Why the last update attempt on this row failed, if it did. */
  updateError: string | null;
  expanded: boolean;
  pending: boolean;
  togglable: boolean;
  onToggle: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onUpdate: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.card}>
      <div className={styles.cardMainRow}>
        <button
          type="button"
          className={styles.cardToggle}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <Glyph
            name="chevronDown"
            size={14}
            className={clsx(styles.cardChevron, !expanded && styles.cardChevronCollapsed)}
          />
          <span className={styles.cardTitle}>{item.name}</span>
          <span className={styles.cardBadge}>{extensionSourceLabel(item, t)}</span>
          {/*
            On the collapsed row too: a package that needs updating should say
            so without being expanded, since that is the row's news.
          */}
          {update !== null ? <span className={styles.updateBadge}>{t("settings.plugins.updateBadge")}</span> : null}
        </button>

        <span
          className={clsx(styles.status, item.enabled ? styles.statusOn : styles.statusOff)}
        >
          {item.enabled ? t("common.enabled") : t("common.disabled")}
        </span>

        {/*
          A switch rather than a checkbox: the row is a piece of state the user
          flips, and `role="switch"` is what makes a screen reader announce it
          that way. Disabled (not hidden) when the workspace is untrusted — the
          state is still true information, it just cannot be changed here.
        */}
        <button
          type="button"
          role="switch"
          aria-checked={item.enabled}
          aria-label={`${item.enabled ? t("common.disable") : t("common.enable")} ${item.name}`}
          className={clsx(
            styles.switch,
            item.enabled && styles.switchOn,
            pending && styles.switchPending,
          )}
          disabled={!togglable || pending}
          onClick={() => onSetEnabled(!item.enabled)}
        >
          <span className={styles.switchKnob} />
        </button>
      </div>

      {expanded ? (
        <dl className={styles.details}>
          <DetailRow label={t("settings.plugins.pathLabel")} value={item.path} />
          <DetailRow label={t("settings.plugins.sourceLabel")} value={extensionSourceLabel(item, t)} />
          <DetailRow label={t("settings.plugins.sourcePathLabel")} value={item.source} />
          <DetailRow
            label={t("settings.plugins.stateLabel")}
            value={item.enabled ? t("common.enabled") : t("common.disabled")}
          />
        </dl>
      ) : null}

      {/*
        Outside the <dl>: the definition list describes the package, while this
        is an action on it. The error stays here rather than becoming a banner,
        so it can only be read next to the button that produced it.
      */}
      {expanded && (update !== null || updateError !== null) ? (
        <div className={styles.updatePanel}>
          {update !== null ? (
            <>
              <span className={styles.updateText}>{t("settings.plugins.upstream")}</span>
              <button
                type="button"
                className={styles.updateAction}
                disabled={updating}
                title={`pi update ${item.source}`}
                onClick={onUpdate}
              >
                {updating ? t("settings.plugins.updating") : t("settings.plugins.update")}
              </button>
            </>
          ) : null}
          {updateError !== null ? (
            <p className={styles.updateError}>{updateError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className={styles.detailRow}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}
