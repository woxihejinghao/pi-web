import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import type { SessionTreeNode, SessionTreeView } from "../../lib/types.ts";
import { Dialog } from "../settings/Dialog.tsx";
import styles from "./TreeDialog.module.css";
import { useT } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";

/**
 * The session's entry tree — pi's `/tree`, rendered for the browser.
 *
 * pi's TUI shows this list and lets you move the leaf to any node. There is no
 * RPC for moving the leaf: the only branch-related method pi exposes is `fork`,
 * which is limited to user messages. So this view shows the tree, marks where
 * the session currently sits, and offers a fork action on the nodes where pi
 * will actually accept one — rather than showing a "switch to this branch"
 * affordance that would quietly do nothing.
 *
 * Labels are this project's own: pi's TUI copy is English terminal text with no
 * zh dictionary to port, so the wording here is written rather than copied.
 */
export function TreeDialog({
  sessionPath,
  onFork,
  onClose,
}: {
  sessionPath: string;
  onFork: (entryId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [tree, setTree] = useState<SessionTreeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getSessionTree(sessionPath)
      .then((result) => {
        if (live) setTree(result);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [sessionPath]);

  /** Ancestors of the leaf, so the current path starts expanded. */
  const leafPath = useMemo(() => {
    if (tree === null || tree.leafId === null) return new Set<string>();
    const path = new Set<string>();
    const walk = (nodes: SessionTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.entry.id === tree.leafId || walk(node.children)) {
          path.add(node.entry.id);
          return true;
        }
      }
      return false;
    };
    walk(tree.tree);
    return path;
  }, [tree]);

  const stats = useMemo(() => {
    if (tree === null) return null;
    let total = 0;
    let branches = 0;
    const walk = (nodes: SessionTreeNode[]): void => {
      for (const node of nodes) {
        total += 1;
        if (node.children.length > 1) branches += 1;
        walk(node.children);
      }
    };
    walk(tree.tree);
    return { total, branches };
  }, [tree]);

  return (
    <Dialog onClose={onClose} label={t("pane.topicTree")}>
      <h2 className={styles.title}>{t("pane.topicTree")}</h2>
      <p className={styles.description}>{t("tree.description")}</p>

      {stats !== null && (
        <p className={styles.stats}>
          {stats.total} 个节点
          {stats.branches > 0 ? ` · ${String(stats.branches)} 处分叉` : " · 尚未分叉"}
          {tree?.source === "disk" ? " · 读取自磁盘" : ""}
        </p>
      )}

      <div className={styles.list}>
        {error !== null ? (
          <p className={styles.error}>{error}</p>
        ) : tree === null ? (
          <p className={styles.empty}>{t("tree.reading")}</p>
        ) : tree.tree.length === 0 ? (
          <p className={styles.empty}>{t("tree.empty")}</p>
        ) : (
          tree.tree.map((node) => (
            <TreeRow
              key={node.entry.id}
              node={node}
              depth={0}
              leafId={tree.leafId}
              expandedByDefault={leafPath}
            />
          ))
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.ghostButton} onClick={onClose}>{t("settings.autoCompaction.off")}</button>
      </div>
    </Dialog>
  );
}

/** A readable one-line label for an entry, without pulling in its full body. */
function describe(
  t: Translate,
  node: SessionTreeNode,
): { icon: "sparkle" | "terminal" | "database" | "settings"; text: string; forkable: boolean } {
  const entry = node.entry;
  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role === "user") {
      return { icon: "sparkle", text: preview(entry.message?.content), forkable: true };
    }
    if (role === "assistant") {
      return { icon: "sparkle", text: preview(entry.message?.content) || t("tree.assistantReply"), forkable: false };
    }
    if (role === "toolResult") {
      return { icon: "terminal", text: t("tree.toolResult"), forkable: false };
    }
    return { icon: "sparkle", text: String(role ?? t("tree.message")), forkable: false };
  }
  if (entry.type === "model_change") {
    return {
      icon: "database",
      text: `模型 · ${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}`,
      forkable: false,
    };
  }
  if (entry.type === "thinking_level_change") {
    return {
      icon: "settings",
      text: `思考级别 · ${String(entry.thinkingLevel ?? "")}`,
      forkable: false,
    };
  }
  if (entry.type === "compaction") {
    return { icon: "database", text: t("tree.compactionSummary"), forkable: false };
  }
  return { icon: "settings", text: entry.type, forkable: false };
}

/** Flatten a message's content down to a short, single-line preview. */
function preview(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { type: string; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
            )
            .map((part) => part.text)
            .join(" ")
        : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function TreeRow({
  node,
  depth,
  leafId,
  expandedByDefault,
}: {
  node: SessionTreeNode;
  depth: number;
  leafId: string | null;
  expandedByDefault: Set<string>;
}) {
  const t = useT();
  const [open, setOpen] = useState(() => expandedByDefault.has(node.entry.id));
  const { icon, text, forkable } = describe(t, node);
  const isLeaf = node.entry.id === leafId;
  const hasChildren = node.children.length > 0;
  const branchPoint = node.children.length > 1;

  return (
    <div className={styles.node}>
      <div
        className={isLeaf ? clsx(styles.row, styles.rowLeaf) : styles.row}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className={styles.caret}
            aria-label={open ? t("common.fold") : t("common.expand")}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Glyph
              name="chevronDown"
              size={12}
              className={open ? styles.caretOpen : styles.caretClosed}
            />
          </button>
        ) : (
          <span className={styles.caretSpacer} />
        )}

        <Glyph name={icon} size={14} className={styles.rowIcon} />
        <span className={styles.rowText}>{text}</span>

        {branchPoint && <span className={styles.tag}>{node.children.length} 个分支</span>}
        {isLeaf && <span className={styles.tagLeaf}>{t("tree.current")}</span>}
        {forkable && (
          <span className={styles.tagFork} title={t("tree.forkableTitle")}>{t("tree.forkable")}</span>
        )}
      </div>

      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.entry.id}
            node={child}
            depth={depth + 1}
            leafId={leafId}
            expandedByDefault={expandedByDefault}
          />
        ))}
    </div>
  );
}
