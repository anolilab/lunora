import type { CSSProperties } from "react";
import { useState } from "react";

import type { AssistantChartConfig, SqlConsoleResult } from "../../../lib/admin";
import type { ResultTab, SqlTab } from "../sql-tabs";
import { addTab, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, isDirty, makeTab, MAX_TABS, tabsClosedBy, usePersistedTabs } from "../sql-tabs";

/** Which bulk close the tab context menu is offering / confirming. */
type BulkClose = "all" | "others" | "right";

/**
 * One editor tab's ephemeral output — the last run's result/error, the statement
 * that failed, the inferred chart, and which result pane is shown. Kept as a
 * single per-tab record (not parallel maps) so a write touches one entry and
 * closing a tab is one `delete`.
 *
 * Everything here is per-TAB because everything here describes one tab's last
 * run. Holding `failed`/`chart` as panel-wide state let a failure in tab A arm
 * "Fix this" in tab B against a statement B never ran, and let A's inferred axes
 * render over B's unrelated columns.
 */
interface TabOutput {
    /** Model-inferred chart for THIS tab's result, or undefined for the manual one. */
    readonly chart?: AssistantChartConfig;
    readonly error: null | string;
    /** THIS tab's last FAILED statement, frozen at failure time — see `run`. */
    readonly failed?: { error: string; sql: string };
    readonly pane: ResultTab;
    readonly result: null | SqlConsoleResult;
}

/** A tab's output before it has run anything. */
const DEFAULT_TAB_OUTPUT: TabOutput = { error: null, pane: "results", result: null };

/** The right-clicked tab's context menu: the target tab id + cursor position. */
interface TabMenu {
    readonly id: string;
    readonly x: number;
    readonly y: number;
}

/**
 * The subset of {@link SqlEditorTabsModel} the tab strip renders. Named here rather
 * than restated at the call site, so the strip cannot quietly acquire the panel's
 * write path into tab state.
 */
type SqlTabStripModel = Pick<
    SqlEditorTabsModel,
    | "activeTab"
    | "addEditorTab"
    | "cancelBulk"
    | "closeEditorTab"
    | "closeTabMenu"
    | "confirmBulk"
    | "menuStyle"
    | "onBackdropContextMenu"
    | "onCloseAll"
    | "onCloseOthers"
    | "onCloseToRight"
    | "openTabMenu"
    | "pendingBulk"
    | "renameTab"
    | "tabMenu"
    | "tabs"
>;

/** Everything {@link useSqlEditorTabs} hands back — the strip's model and the panel's write path into the active tab. */
interface SqlEditorTabsModel {
    /** The tab whose draft the editor is showing. Never undefined — falls back to a fresh tab. */
    readonly activeTab: SqlTab;
    readonly activeTabId: string;
    /** Add a new empty tab and switch to it (no-op once MAX_TABS are open). */
    readonly addEditorTab: () => void;
    readonly cancelBulk: () => void;
    readonly closeEditorTab: (id: string) => void;
    readonly closeTabMenu: () => void;
    readonly confirmBulk: () => void;
    /** Absolute position for the context menu, or undefined when it is closed. */
    readonly menuStyle: CSSProperties | undefined;
    readonly onBackdropContextMenu: (event: React.MouseEvent) => void;
    readonly onCloseAll: () => void;
    readonly onCloseOthers: () => void;
    readonly onCloseToRight: () => void;
    readonly openTabMenu: (id: string, event: React.MouseEvent) => void;
    /** The active tab's ephemeral output — its last run's result/error/pane. */
    readonly output: TabOutput;
    /** Merge a patch into the active tab's output. A key present as `undefined` clears it. */
    readonly patchActiveOutput: (patch: Partial<TabOutput>) => void;
    /** Patch the active tab's persisted fields (draft text and/or saved-query link). */
    readonly patchActiveTab: (patch: Partial<Pick<SqlTab, "activeId" | "sql">>) => void;
    /** The bulk close awaiting a discard confirm (it would drop unsaved tabs), or null. */
    readonly pendingBulk: BulkClose | null;
    readonly renameTab: (id: string, name: string) => void;
    readonly setActiveTabId: (id: string) => void;
    /** The open context menu's target + position, or null when closed. */
    readonly tabMenu: TabMenu | null;
    readonly tabs: ReadonlyArray<SqlTab>;
    /** Unlink every tab mirroring `queryId` — used when that saved query is deleted. */
    readonly unlinkQuery: (queryId: string) => void;
}

/**
 * The SQL editor's tabs: which are open, which is active, each one's ephemeral
 * output, and the right-click menu's bulk-close operations (with their unsaved-work
 * confirm).
 *
 * One hook because all of it is the same question — "which tab am I looking at" —
 * and none of it touches the query, the schema, or the saved-query library. Split
 * out of the panel, where four `useState` clusters and fourteen handlers were
 * interleaved with the run path.
 */
const useSqlEditorTabs = (seedTab: () => SqlTab): SqlEditorTabsModel => {
    const { activeId: activeTabId, setActiveId: setActiveTabId, setTabs, tabs } = usePersistedTabs(seedTab);
    const [outputs, setOutputs] = useState<Record<string, TabOutput>>({});
    const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
    const [pendingBulk, setPendingBulk] = useState<BulkClose | null>(null);

    // The active tab is the source of truth for the editor's draft + saved-query
    // link. Never undefined: a persisted id that no longer exists falls back to the
    // first open tab, and an empty set to a fresh one.
    const activeTab = tabs.find((each) => each.id === activeTabId) ?? tabs[0] ?? makeTab();
    const output = outputs[activeTab.id] ?? DEFAULT_TAB_OUTPUT;

    // Patch the active tab's persisted fields (draft text and/or saved-query link).
    const patchActiveTab = (patch: Partial<Pick<SqlTab, "activeId" | "sql">>): void => {
        setTabs((current) => current.map((each) => (each.id === activeTab.id ? { ...each, ...patch } : each)));
    };

    // Merge a patch into the active tab's ephemeral output. Omitted keys keep
    // their previous value; a key present as `undefined` clears it (which is how
    // a fresh run drops the previous failure and inferred chart).
    const patchActiveOutput = (patch: Partial<TabOutput>): void => {
        setOutputs((current) => {
            const previous = current[activeTab.id] ?? DEFAULT_TAB_OUTPUT;

            return { ...current, [activeTab.id]: { ...previous, ...patch } };
        });
    };

    // Add a new empty tab and switch to it (no-op once MAX_TABS are open).
    const addEditorTab = (): void => {
        if (tabs.length >= MAX_TABS) {
            return;
        }

        const fresh = makeTab();

        setTabs((current) => addTab(current, fresh));
        setActiveTabId(fresh.id);
    };

    // Commit a new tab set + active id, pruning ephemeral output down to the
    // surviving tabs so dead keys can't accumulate over a session. Shared by the
    // single close and the bulk close-others / close-to-right / close-all paths.
    const commitTabs = (next: { activeId: string; tabs: SqlTab[] }): void => {
        setTabMenu(null);
        setPendingBulk(null);
        setTabs(next.tabs);
        setActiveTabId(next.activeId);

        const openIds = new Set(next.tabs.map((each) => each.id));

        setOutputs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => openIds.has(key))));
    };

    const closeEditorTab = (id: string): void => {
        commitTabs(closeTab(tabs, id, makeTab));
    };

    // Apply a bulk close (the dirty-tab guard is handled by the caller).
    const applyBulk = (op: BulkClose, id: string): void => {
        if (op === "others") {
            commitTabs(closeOtherTabs(tabs, id));
        } else if (op === "right") {
            commitTabs(closeTabsToRight(tabs, id, activeTabId));
        } else {
            commitTabs(closeAllTabs(makeTab));
        }
    };

    // Run a bulk close, but route it through an inline discard confirm first when
    // it would drop a tab with unsaved work (matching the single-close guard).
    const requestBulk = (op: BulkClose): void => {
        if (tabMenu === null) {
            return;
        }

        if (tabsClosedBy(op, tabs, tabMenu.id).some((each) => isDirty(each))) {
            setPendingBulk(op);
        } else {
            applyBulk(op, tabMenu.id);
        }
    };

    // Open the tab context menu at the cursor for the right-clicked tab.
    const openTabMenu = (id: string, event: React.MouseEvent): void => {
        event.preventDefault();
        setPendingBulk(null);
        setTabMenu({ id, x: event.clientX, y: event.clientY });
    };

    const closeTabMenu = (): void => {
        setTabMenu(null);
        setPendingBulk(null);
    };
    const onBackdropContextMenu = (event: React.MouseEvent): void => {
        event.preventDefault();
        setTabMenu(null);
        setPendingBulk(null);
    };
    const onCloseOthers = (): void => {
        requestBulk("others");
    };
    const onCloseToRight = (): void => {
        requestBulk("right");
    };
    const onCloseAll = (): void => {
        requestBulk("all");
    };
    const confirmBulk = (): void => {
        if (tabMenu !== null && pendingBulk !== null) {
            applyBulk(pendingBulk, tabMenu.id);
        }

        setPendingBulk(null);
    };
    const cancelBulk = (): void => {
        setPendingBulk(null);
    };
    const tabMenuStyle = tabMenu === null ? undefined : { left: tabMenu.x, top: tabMenu.y };

    const unlinkQuery = (queryId: string): void => {
        setTabs((current) => current.map((each) => (each.activeId === queryId ? { ...each, activeId: null } : each)));
    };

    // Set a tab's custom title (blank reverts it to the draft-derived label).
    const renameTab = (id: string, name: string): void => {
        setTabs((current) => current.map((each) => (each.id === id ? { ...each, name } : each)));
    };
    return {
        activeTab,
        activeTabId,
        addEditorTab,
        cancelBulk,
        closeEditorTab,
        closeTabMenu,
        confirmBulk,
        menuStyle: tabMenuStyle,
        onBackdropContextMenu,
        onCloseAll,
        onCloseOthers,
        onCloseToRight,
        openTabMenu,
        output,
        patchActiveOutput,
        patchActiveTab,
        pendingBulk,
        renameTab,
        setActiveTabId,
        tabMenu,
        tabs,
        unlinkQuery,
    };
};

export { useSqlEditorTabs };
export type { SqlEditorTabsModel, SqlTabStripModel };
