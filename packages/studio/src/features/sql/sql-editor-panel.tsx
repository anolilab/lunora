import { useLunora } from "@lunora/react";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useId, useRef, useState } from "react";

import SqlResultChart from "../../components/result-chart";
import { ShardInput } from "../../components/shard-input";
import { Alert } from "../../components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { newId, usePersistedList, usePersistedValue } from "../../lib/browser-storage";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { CellValue } from "../data/data-grid";
import { ExportMenu } from "../data/grid-features";
import { EDITOR_TEXT_CLASS } from "./editor-spans";
import formatSql from "./format-sql";
import { useSqlAssistant } from "./hooks/use-sql-assistant";
import { useSqlDiagnostics } from "./hooks/use-sql-diagnostics";
import { SqlAssistantBar } from "./sql-assistant-bar";
import { AutocompletePopover, useSqlAutocomplete } from "./sql-autocomplete-ui";
import type { SqlDiagnostic } from "./sql-diagnostics";
import { DiagnosticsOverlay, DiagnosticsRow } from "./sql-diagnostics-ui";
import type { HistoryEntry, SavedQuery } from "./sql-query-sidebar";
import { SqlQuerySidebar, TEMPLATES } from "./sql-query-sidebar";
import { referencedTables, useSqlSchema } from "./sql-schema";
import TabButton from "./sql-tab-button";
import type { SqlTab } from "./sql-tabs";
import { addTab, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, isDirty, makeTab, MAX_TABS, tabsClosedBy, usePersistedTabs } from "./sql-tabs";

/** Which bulk close the tab context menu is offering / confirming. */
type BulkClose = "all" | "others" | "right";

interface SqlEditorPanelProps {
    /** Shard key the query runs against on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);
const STORAGE_KEY = "lunora-studio-sql-queries";
const HISTORY_KEY = "lunora-studio-sql-history";
/** Persisted editor↔results layout: `false` stacks them (default), `true` splits side by side for wide screens. */
const SPLIT_VIEW_KEY = "lunora-studio-sql-split-view";

/** How many recent distinct queries the history keeps. */
const HISTORY_LIMIT = 25;
/** Line-number gutter sizing, aligned to the editor textarea's padding + line height. */
const GUTTER_STYLE: CSSProperties = { minWidth: "2.75rem", paddingInline: "0.5rem" };
/** Which results sub-pane is shown. */
type ResultTab = "chart" | "explain" | "results";

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

/** The results table for a successful query — sticky header, monospace cells, NULL-aware. */
const SqlResultTable = ({ result }: { readonly result: SqlConsoleResult }): ReactElement => {
    if (result.columns.length === 0) {
        return <p className="p-4 text-sm text-muted-foreground">{result.rowCount === 0 ? "0 rows" : ""}</p>;
    }

    return (
        <Table data-testid="sql-rows">
            <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                    {result.columns.map((column) => (
                        <TableHead key={column}>{column}</TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {result.rows.map((row, rowIndex) => (
                    // eslint-disable-next-line react-x/no-array-index-key -- a raw SQL result row has no stable identity; position is the only key
                    <TableRow data-testid="sql-row" key={rowIndex}>
                        {result.columns.map((column) => (
                            <TableCell className="max-w-md truncate font-mono text-xs" key={column}>
                                <CellValue value={row[column]} />
                            </TableCell>
                        ))}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
};

/**
 * A full-height, Supabase-style SQL editor: a left query sidebar (search + new,
 * a browser-persisted PRIVATE list, and REFERENCE templates), a line-numbered
 * editor pane, and a Results / Explain pane with a Run control + shard selector.
 * Read-only — the `__lunora_admin__:runSql` RPC rejects everything but
 * SELECT / WITH / EXPLAIN, so raw writes can't desync the doc-store's shadow
 * tables (use the Data grid's inline edit for mutations).
 */
export const SqlEditorPanel = ({ initialShardKey }: SqlEditorPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [queries, setQueries] = usePersistedList<SavedQuery>(STORAGE_KEY);
    const [history, setHistory] = usePersistedList<HistoryEntry>(HISTORY_KEY);
    const [search, setSearch] = useState<string>("");

    // Multiple editor tabs: each persisted tab owns its draft + the saved-query
    // it mirrors; the result/error/pane are kept per tab in ephemeral maps so a
    // reload restores the open tabs (and their text) but re-runs for results.
    const seedTab = (): SqlTab => makeTab(TEMPLATES[0]?.sql ?? "");
    const { activeId: activeTabId, setActiveId: setActiveTabId, setTabs, tabs } = usePersistedTabs(seedTab);

    // One ephemeral output record per tab id (result + error + result-pane). Not
    // persisted, so a reload restores the open tabs and their text but re-runs for
    // results. Closing a tab deletes its entry — no stale keys accumulate.
    const [outputs, setOutputs] = useState<Record<string, TabOutput>>({});

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [running, setRunning] = useState<boolean>(false);
    // Editor↔results layout: stacked (default) or side-by-side, persisted across reloads.
    const [splitView, setSplitView] = usePersistedValue<boolean>(SPLIT_VIEW_KEY, false);
    // The right-clicked tab's context menu: the target tab id + cursor position, or null when closed.
    const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
    // The bulk close awaiting a discard confirm (because it would drop unsaved tabs), or null.
    const [pendingBulk, setPendingBulk] = useState<BulkClose | null>(null);

    const gutterRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);
    const privateListRef = useRef<HTMLUListElement | null>(null);
    const listboxId = useId();

    const { probe, schema } = useSqlSchema(shardKey);

    // The active tab is the source of truth for the editor's draft + saved-query
    // link; `result`/`error`/`tab` read out of the per-tab ephemeral maps.
    const activeTab = tabs.find((each) => each.id === activeTabId) ?? tabs[0] ?? makeTab();
    const draft = activeTab.sql;
    const { activeId } = activeTab;
    const output = outputs[activeTab.id] ?? DEFAULT_TAB_OUTPUT;
    const { chart: inferredChart, error, failed: failedRun, result } = output;
    const tab = output.pane;

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

    // Set the active tab's draft and keep the linked saved query in sync (auto-save).
    const setDraft = (value: string): void => {
        patchActiveTab({ sql: value });

        if (activeId !== null) {
            setQueries((current) => current.map((query) => (query.id === activeId ? { ...query, sql: value } : query)));
        }
    };

    const diagnostics = useSqlDiagnostics(draft, schema, shardKey);
    const assistant = useSqlAssistant(shardKey);

    const inferChart = (): void => {
        if (result === null) {
            return;
        }

        const apply = async (): Promise<void> => {
            // The result's SHAPE only — never its rows (plan 202 Phase 0).
            const chart = await assistant.inferChart({
                columns: result.columns,
                rowCount: result.rowCount,
                types: Object.fromEntries(result.columns.map((column) => [column, typeof (result.rows[0]?.[column] ?? "")])),
            });

            patchActiveOutput({ chart });
        };

        fireAndForget(apply());
    };

    const autocomplete = useSqlAutocomplete(schema, editorRef, setDraft);
    const {
        close: closeAutocomplete,
        commit: commitAutocomplete,
        move: moveAutocomplete,
        refresh: refreshAutocomplete,
        state: autocompleteState,
    } = autocomplete;

    // Pick the suggestion at `index` from the mouse path (mirror the keyboard commit).
    const onPickSuggestion = (index: number): void => {
        moveAutocomplete(index - (autocompleteState?.active ?? 0));
        commitAutocomplete();
    };

    // Re-derive completions once a probe resolves new columns: a `tbl.` qualifier
    // typed before its columns loaded would otherwise show an empty popover until
    // the next keystroke. Only re-runs while the editor is focused, against its
    // live caret, so it never pops a menu the operator didn't ask for.
    useEffect(() => {
        const node = editorRef.current;

        if (node !== null && node === document.activeElement) {
            refreshAutocomplete(node.value, node.selectionStart);
        }
    }, [refreshAutocomplete, schema]);

    // Record a successfully-run query at the head of the history, de-duping an
    // identical consecutive run and any earlier copy, capped to HISTORY_LIMIT.
    const recordHistory = (sql: string): void => {
        setHistory((current) => {
            if (current[0]?.sql === sql) {
                return current;
            }

            const next: HistoryEntry[] = [{ at: Date.now(), sql }, ...current.filter((entry) => entry.sql !== sql)];

            return next.slice(0, HISTORY_LIMIT);
        });
    };

    const run = async (mode: ResultTab): Promise<void> => {
        if (draft.trim() === "") {
            return;
        }

        setRunning(true);
        const sql = mode === "explain" ? `EXPLAIN QUERY PLAN ${draft}` : draft;

        try {
            const next = (await client.query(RUN_SQL, { sql }, callOptions(shardKey))) as SqlConsoleResult;

            patchActiveOutput({ chart: undefined, error: null, failed: undefined, pane: mode, result: next });
            recordShard(shardKey);
            recordHistory(sql);
        } catch (error_: unknown) {
            // Capture the statement that actually failed. "Fix this" previously
            // read the live draft, so any edit after the failure asked the model
            // to repair text that never ran, against an error it never produced.
            patchActiveOutput({ chart: undefined, error: errorMessage(error_), failed: { error: errorMessage(error_), sql }, pane: mode, result: null });
        }

        setRunning(false);
    };

    const onRun = (): void => {
        fireAndForget(run("results"));
    };

    // Edit the draft (auto-saving the linked query) and re-derive completions
    // from the new caret position, pre-probing any table the draft now names.
    const onDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        const { selectionStart, value } = event.target;

        setDraft(value);

        for (const table of referencedTables(value)) {
            probe(table);
        }

        refreshAutocomplete(value, selectionStart);
    };

    // Re-derive completions when the caret moves without an edit (arrow keys, click).
    const onEditorSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>): void => {
        const node = event.currentTarget;

        refreshAutocomplete(node.value, node.selectionStart);
    };

    const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        // Autocomplete navigation takes the keys while the popover is open.
        if (autocompleteState !== null) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveAutocomplete(1);

                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                moveAutocomplete(-1);

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                closeAutocomplete();

                return;
            }

            if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && commitAutocomplete()) {
                event.preventDefault();

                return;
            }
        }

        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            fireAndForget(run(tab));
        }
    };

    const onEditorBlur = (): void => {
        // Defer so a mousedown-pick on a suggestion still resolves before close.
        requestAnimationFrame(() => {
            closeAutocomplete();
        });
    };

    // Keep the line-number gutter and the diagnostics overlay aligned with the
    // textarea's scroll. The overlay tracks both axes — a wide statement scrolls
    // horizontally, and a squiggle that doesn't follow is worse than none.
    const onEditorScroll = (event: React.UIEvent<HTMLTextAreaElement>): void => {
        const { scrollLeft, scrollTop } = event.currentTarget;

        if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = scrollTop;
        }

        if (overlayRef.current !== null) {
            overlayRef.current.scrollTop = scrollTop;
            overlayRef.current.scrollLeft = scrollLeft;
        }
    };

    // Reveal and select a diagnostic's span from the problems row, so a message
    // like "unknown table `userz`" lands the caret on `userz`.
    const revealDiagnostic = (diagnostic: SqlDiagnostic): void => {
        const node = editorRef.current;

        if (node === null || diagnostic.offset === undefined) {
            return;
        }

        node.focus();
        node.setSelectionRange(diagnostic.offset, diagnostic.offset + (diagnostic.length ?? 0));
    };

    // Load `sql` into the active tab as a fresh draft, link it to `savedId` (or
    // unlink with `null`), and clear that tab's stale result/error.
    const loadIntoActiveTab = (sql: string, savedId: null | string): void => {
        setTabs((current) => current.map((each) => (each.id === activeTab.id ? { ...each, activeId: savedId, sql } : each)));
        patchActiveOutput({ chart: undefined, error: null, failed: undefined, result: null });
    };

    const newQuery = (): void => {
        const query: SavedQuery = { id: newId("q"), name: t("Untitled query"), sql: "" };

        setQueries((current) => [query, ...current]);
        loadIntoActiveTab("", query.id);
    };

    const selectQuery = (id: string): void => {
        const found = queries.find((query) => query.id === id);

        if (found !== undefined) {
            loadIntoActiveTab(found.sql, id);
            // Reveal the loaded query in the (possibly scrolled) Private list so the
            // operator sees which one is now active.
            privateListRef.current?.querySelector(`[data-testid="sql-query-${id}"]`)?.scrollIntoView({ block: "nearest" });
        }
    };

    const deleteQuery = (id: string): void => {
        setQueries((current) => current.filter((query) => query.id !== id));
        // Unlink any tab that was editing the deleted query.
        setTabs((current) => current.map((each) => (each.activeId === id ? { ...each, activeId: null } : each)));
    };

    const loadTemplate = (event: React.MouseEvent<HTMLButtonElement>): void => {
        loadIntoActiveTab(event.currentTarget.dataset.sql ?? "", null);
    };

    // Load a past run back into the editor as a fresh draft (not a saved query).
    const loadFromHistory = (event: React.MouseEvent<HTMLButtonElement>): void => {
        loadIntoActiveTab(event.currentTarget.dataset.sql ?? "", null);
    };

    const clearHistory = (): void => {
        setHistory([]);
    };

    // Pretty-print the current draft in place (auto-saving the active query too).
    const formatDraft = (): void => {
        setDraft(formatSql(draft));
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

    const selectTab = (id: string): void => {
        closeAutocomplete();
        setActiveTabId(id);
    };

    // Set a tab's custom title (blank reverts it to the draft-derived label).
    const renameTab = (id: string, name: string): void => {
        setTabs((current) => current.map((each) => (each.id === id ? { ...each, name } : each)));
    };

    const showResults = (): void => {
        patchActiveOutput({ pane: "results" });
    };

    const showExplain = (): void => {
        fireAndForget(run("explain"));
    };

    const showChart = (): void => {
        patchActiveOutput({ pane: "chart" });
    };

    const toggleSplit = (): void => {
        setSplitView(!splitView);
    };

    const lineCount = draft.split("\n").length;
    const onSearchChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    const tabClass = (selected: boolean): string =>
        `border-b-2 px-3 py-2 text-sm outline-none transition-colors ${selected ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

    // Editor + results share a flex container; `splitView` flips its axis (and the
    // results pane from a bottom band to a right column) — the only layout change.
    const workspaceClass = splitView ? "flex min-h-0 flex-1 flex-row" : "flex min-h-0 flex-1 flex-col";
    const resultsClass = splitView
        ? "flex w-2/5 min-h-0 min-w-0 shrink-0 flex-col border-s border-border"
        : "flex h-2/5 min-h-0 shrink-0 flex-col border-t border-border";

    return (
        <div className="flex h-full min-w-0" data-testid="lunora-sql-editor">
            <SqlQuerySidebar
                activeId={activeId}
                history={history}
                listRef={privateListRef}
                onClearHistory={clearHistory}
                onDelete={deleteQuery}
                onLoadHistory={loadFromHistory}
                onLoadTemplate={loadTemplate}
                onNew={newQuery}
                onSearchChange={onSearchChange}
                onSelect={selectQuery}
                queries={queries}
                search={search}
            />

            {/* Editor + results. */}
            <div className="flex min-w-0 flex-1 flex-col">
                {/* Editor tab strip. */}
                <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/30" data-testid="sql-tab-strip" role="tablist">
                    {tabs.map((each) => (
                        <TabButton
                            active={each.id === activeTab.id}
                            canClose={tabs.length > 1}
                            key={each.id}
                            onClose={closeEditorTab}
                            onMenu={openTabMenu}
                            onRename={renameTab}
                            onSelect={selectTab}
                            tab={each}
                        />
                    ))}
                    <button
                        aria-label={t("New tab")}
                        className="flex size-8 shrink-0 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                        data-testid="sql-tab-add"
                        disabled={tabs.length >= MAX_TABS}
                        onClick={addEditorTab}
                        title={t("New tab")}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-4"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.7}
                            viewBox="0 0 24 24"
                        >
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    </button>
                </div>

                {/* Right-click tab context menu: bulk close operations. */}
                {tabMenu !== null && (
                    <>
                        <div
                            className="fixed inset-0 z-40"
                            data-testid="sql-tab-menu-backdrop"
                            onClick={closeTabMenu}
                            onContextMenu={onBackdropContextMenu}
                            role="presentation"
                        />
                        <div
                            className="fixed z-50 min-w-44 rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
                            data-testid="sql-tab-menu"
                            role="menu"
                            style={tabMenuStyle}
                        >
                            {pendingBulk === null ? (
                                <>
                                    <button
                                        className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                                        data-testid="sql-tab-menu-close-others"
                                        disabled={tabs.length <= 1}
                                        onClick={onCloseOthers}
                                        role="menuitem"
                                        type="button"
                                    >
                                        {t("Close other tabs")}
                                    </button>
                                    <button
                                        className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                                        data-testid="sql-tab-menu-close-right"
                                        disabled={tabs.findIndex((each) => each.id === tabMenu.id) >= tabs.length - 1}
                                        onClick={onCloseToRight}
                                        role="menuitem"
                                        type="button"
                                    >
                                        {t("Close tabs to the right")}
                                    </button>
                                    <button
                                        className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent"
                                        data-testid="sql-tab-menu-close-all"
                                        onClick={onCloseAll}
                                        role="menuitem"
                                        type="button"
                                    >
                                        {t("Close all tabs")}
                                    </button>
                                </>
                            ) : (
                                // Discard confirm: the chosen bulk close would drop a tab with unsaved work.
                                <div className="px-3 py-1.5" data-testid="sql-tab-menu-confirm">
                                    <p className="pb-1.5 text-xs text-muted-foreground">{t("Discard unsaved tabs?")}</p>
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            className="rounded px-2 py-1 text-xs font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:bg-destructive/10"
                                            data-testid="sql-tab-menu-confirm-discard"
                                            onClick={confirmBulk}
                                            type="button"
                                        >
                                            {t("Discard")}
                                        </button>
                                        <button
                                            className="rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                                            data-testid="sql-tab-menu-confirm-cancel"
                                            onClick={cancelBulk}
                                            type="button"
                                        >
                                            {t("Cancel")}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* Editor + results workspace — stacked, or split side-by-side. */}
                <div className={workspaceClass}>
                    {/* Line-numbered editor pane, with the assistant bar, diagnostics overlay + problems row. */}
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <SqlAssistantBar assistant={assistant} failed={failedRun} onGenerated={setDraft} />
                        <div className="flex min-h-0 min-w-0 flex-1">
                            <div
                                aria-hidden="true"
                                className="shrink-0 select-none overflow-hidden border-e border-border bg-muted/30 py-3 text-end font-mono text-xs leading-5 text-muted-foreground/60"
                                ref={gutterRef}
                                style={GUTTER_STYLE}
                            >
                                {Array.from({ length: lineCount }, (_, index) => (
                                    <div key={index}>{index + 1}</div>
                                ))}
                            </div>
                            {/* The background lives on the wrapper, not the textarea: the
                                overlay sits behind the (transparent) textarea, so an opaque
                                textarea would hide every squiggle. */}
                            <div className="relative min-w-0 flex-1 bg-background">
                                <DiagnosticsOverlay diagnostics={diagnostics} draft={draft} scrollRef={overlayRef} />
                                <textarea
                                    aria-activedescendant={autocompleteState === null ? undefined : `${listboxId}-opt-${autocompleteState.active.toString()}`}
                                    aria-autocomplete="list"
                                    aria-controls={autocompleteState === null ? undefined : listboxId}
                                    aria-expanded={autocompleteState !== null}
                                    aria-label={t("SQL query")}
                                    className={`relative size-full resize-none bg-transparent outline-none ${EDITOR_TEXT_CLASS}`}
                                    data-testid="sql-input"
                                    onBlur={onEditorBlur}
                                    onChange={onDraftChange}
                                    onKeyDown={onEditorKeyDown}
                                    onScroll={onEditorScroll}
                                    onSelect={onEditorSelect}
                                    placeholder="SELECT * FROM …"
                                    ref={editorRef}
                                    role="combobox"
                                    spellCheck={false}
                                    value={draft}
                                />
                                <AutocompletePopover listboxId={listboxId} onPick={onPickSuggestion} state={autocompleteState} />
                            </div>
                        </div>
                        <DiagnosticsRow diagnostics={diagnostics} onSelect={revealDiagnostic} />
                    </div>

                    {/* Results pane. */}
                    <div className={resultsClass}>
                        <div className="flex shrink-0 items-center gap-2 border-b border-border pe-2">
                            <button className={tabClass(tab === "results")} data-testid="sql-tab-results" onClick={showResults} type="button">
                                {t("Results")}
                            </button>
                            <button className={tabClass(tab === "chart")} data-testid="sql-tab-chart" onClick={showChart} type="button">
                                {t("Chart")}
                            </button>
                            {/* Chart inference, hidden without an AI binding. */}
                            {!assistant.unavailable && tab === "chart" && result !== null && (
                                <button
                                    className={tabClass(false)}
                                    data-testid="sql-infer-chart"
                                    disabled={assistant.pending("chart")}
                                    onClick={inferChart}
                                    type="button"
                                >
                                    {assistant.pending("chart") ? t("Thinking…") : t("Suggest chart")}
                                </button>
                            )}
                            <button className={tabClass(tab === "explain")} data-testid="sql-tab-explain" onClick={showExplain} type="button">
                                {t("Explain")}
                            </button>
                            <div className="ms-auto flex items-center gap-2">
                                <button
                                    aria-label={t("Split editor and results")}
                                    aria-pressed={splitView}
                                    className={`inline-flex items-center rounded-md border border-border px-2 py-1.5 outline-none transition-colors hover:bg-accent focus-visible:bg-accent ${splitView ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                                    data-testid="sql-split-toggle"
                                    onClick={toggleSplit}
                                    title={t("Split editor and results")}
                                    type="button"
                                >
                                    <svg
                                        aria-hidden="true"
                                        className="size-4"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.7}
                                        viewBox="0 0 24 24"
                                    >
                                        <rect height="16" rx="2" width="18" x="3" y="4" />
                                        <path d="M12 4v16" />
                                    </svg>
                                </button>
                                {result !== null && result.columns.length > 0 && <ExportMenu columns={result.columns} name="query-result" rows={result.rows} />}
                                <button
                                    className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
                                    data-testid="sql-format"
                                    disabled={running}
                                    onClick={formatDraft}
                                    type="button"
                                >
                                    {t("Format")}
                                </button>
                                <ShardInput onChange={setShardKey} testId="sql-shard-input" value={shardKey} />
                                <button
                                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                                    data-testid="sql-run"
                                    disabled={running}
                                    onClick={onRun}
                                    type="button"
                                >
                                    {running ? t("Running…") : t("Run")}
                                    <kbd className="rounded border border-primary-foreground/30 px-1 font-sans text-[10px]">⌘↵</kbd>
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto">
                            {error !== null && (
                                <Alert className="m-3 font-mono text-xs" testId="sql-error" variant="destructive">
                                    {error}
                                </Alert>
                            )}

                            {error === null && result === null && (
                                <p className="p-4 text-sm text-muted-foreground" data-testid="sql-empty">
                                    {t("Click Run to execute your query.")}
                                </p>
                            )}

                            {error === null && result !== null && (
                                <div data-testid="sql-result">
                                    {tab === "chart" ? <SqlResultChart axes={inferredChart} result={result} /> : <SqlResultTable result={result} />}
                                    <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="sql-count">
                                        {result.truncated
                                            ? t("Showing the first {max} of {count} rows.", { count: result.rowCount, max: result.rows.length })
                                            : t("{count} rows", { count: result.rowCount })}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export type { SqlEditorPanelProps };
