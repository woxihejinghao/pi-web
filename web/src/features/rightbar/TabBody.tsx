import { lazy, Suspense } from "react";
import { useT } from "../../lib/app-state.ts";
import { BrowserTab } from "./BrowserTab.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { PreviewTab } from "./PreviewTab.tsx";
import type { RightbarTab } from "./rightbar-state.ts";
import pane from "./Pane.module.css";

/**
 * The terminal body is the one tab that arrives on demand.
 *
 * xterm plus its fit addon is ~340 kB of the bundle and this tab is its only
 * consumer, so nothing else should pay for it on the first paint. That matters
 * more here than for the other tabs: the shell is an optional capability, and
 * a host without a prebuilt node-pty can never open one at all. The strip, the
 * "+" menu and the reattach path stay in the main chunk — only the screen moves
 * behind the boundary, and the chunk comes off the same origin as the page.
 */
const TerminalTab = lazy(async () => {
  const module = await import("./TerminalTab.tsx");
  return { default: module.TerminalTab };
});

/**
 * One tab's content, wherever it is being drawn.
 *
 * A pane and a floating panel show the same thing, so they show it through the
 * same component: a second switch on `tab.kind` is how a new tab type ends up
 * working in one place and not the other. Callers pass `key={tab.id}` so
 * switching tabs — or a tab moving between panes — remounts rather than reusing
 * the previous body's state.
 */
export function TabBody({
  sessionPath,
  projectId,
  projectPath,
  tab,
  onOpenFile,
}: {
  /** The session whose surface this tab belongs to; the terminal store and the
   * right sidebar are both keyed by it, so one value serves both. */
  sessionPath: string;
  projectId: string;
  projectPath: string;
  tab: RightbarTab;
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  if (tab.kind === "files") {
    return (
      <FilesTab key={projectId} projectId={projectId} rootLabel={projectPath} onOpenFile={onOpenFile} />
    );
  }
  if (tab.kind === "preview") {
    // Keyed by tab id so two tabs previewing the same file keep their own
    // scroll position and load state.
    return <PreviewTab key={tab.id} projectId={projectId} tab={tab} />;
  }
  if (tab.kind === "changes") {
    return <ChangesTab key={tab.id} projectId={projectId} onOpenFile={onOpenFile} />;
  }
  if (tab.kind === "terminal") {
    return (
      <Suspense fallback={<div className={pane.note}>{t("common.loading")}</div>}>
        <TerminalTab
          key={tab.id}
          sessionPath={sessionPath}
          projectPath={projectPath}
          tabKey={sessionPath}
          tab={tab}
        />
      </Suspense>
    );
  }
  return <BrowserTab key={tab.id} sessionPath={sessionPath} tab={tab} />;
}
