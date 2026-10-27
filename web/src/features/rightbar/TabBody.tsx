import { lazy, Suspense } from "react";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { useT } from "../../lib/app-state.ts";
import { reloadOnceForStaleChunk } from "../../lib/stale-chunk.ts";
import { BrowserTab } from "./BrowserTab.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { PlanTab } from "./PlanTab.tsx";
import { PreviewTab } from "./PreviewTab.tsx";
import { TurnChangesTab } from "./TurnChangesTab.tsx";
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
  try {
    const module = await import("./TerminalTab.tsx");
    return { default: module.TerminalTab };
  } catch (error) {
    // A build replaced the directory this page was served from, so this
    // fingerprint no longer exists and the request came back as the SPA's HTML
    // shell instead of a script. Reloading refetches the current one, and it is
    // allowed once per chunk; past that the rejection has to reach the boundary
    // below, which says what happened (see `lib/stale-chunk.ts`).
    if (reloadOnceForStaleChunk("terminal-tab")) {
      // Never settles: the document is on its way out, and staying suspended
      // keeps the loading note up rather than flashing a panel on the way.
      return new Promise<never>(() => {});
    }
    throw error;
  }
});

interface TabBodyProps {
  /** The session whose surface this tab belongs to; the terminal store and the
   * right sidebar are both keyed by it, so one value serves both. */
  sessionPath: string;
  projectId: string;
  projectPath: string;
  tab: RightbarTab;
  onOpenFile: (path: string) => void;
}

/**
 * One tab's content, wherever it is being drawn.
 *
 * Hung under the pane-level boundary because a tab is the app's only optional
 * surface: a terminal whose chunk is missing, or a diff that parses into a
 * shape nothing expected, should cost that one tab rather than the whole
 * conversation — and the shell that replaces it offers a retry.
 *
 * Callers pass `key={tab.id}`, which is on this element, so switching tabs — or
 * a tab moving between panes — remounts rather than reusing the previous
 * body's state. A retry after a failure therefore starts clean. */
export function TabBody(props: TabBodyProps) {
  return (
    <ErrorBoundary scope="pane">
      <TabContent {...props} />
    </ErrorBoundary>
  );
}

/**
 * The switch itself.
 *
 * A pane and a floating panel show the same thing, so they show it through the
 * same component: a second switch on `tab.kind` is how a new tab type ends up
 * working in one place and not the other.
 */
function TabContent({ sessionPath, projectId, projectPath, tab, onOpenFile }: TabBodyProps) {
  const t = useT();
  if (tab.kind === "files") {
    return (
      <FilesTab key={projectId} projectId={projectId} rootLabel={projectPath} onOpenFile={onOpenFile} />
    );
  }
  if (tab.kind === "preview") {
    // Keyed by tab id so two tabs previewing the same file keep their own
    // scroll position and load state.
    return (
      <PreviewTab
        key={tab.id}
        projectId={projectId}
        projectPath={projectPath}
        sessionPath={sessionPath}
        tab={tab}
      />
    );
  }
  if (tab.kind === "changes") {
    return <ChangesTab key={tab.id} projectId={projectId} onOpenFile={onOpenFile} />;
  }
  if (tab.kind === "changes-review") {
    // Reads the transcript's published projection rather than the working tree:
    // a review is about one turn, and only the conversation knows what it wrote.
    return (
      <TurnChangesTab key={tab.id} sessionPath={sessionPath} tab={tab} onOpenFile={onOpenFile} />
    );
  }
  if (tab.kind === "plan") {
    // The same bridge, for the same reason: the document is the one the
    // conversation submitted, so the conversation is the one holding it.
    return <PlanTab key={tab.id} sessionPath={sessionPath} tab={tab} />;
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
