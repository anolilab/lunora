import { useCirrus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import SqlResultChart from "../../components/result-chart";
import { ShardInput } from "../../components/shard-input";
import { Alert } from "../../components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import type { SqlConsoleResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { newId, usePersistedList } from "../../lib/browser-storage";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import { CellValue } from "../data/data-grid";
import { ExportMenu } from "../data/grid-features";
import formatSql from "./format-sql";
import { AutocompletePopover, useSqlAutocomplete } from "./sql-autocomplete-ui";
import type { HistoryEntry, SavedQuery } from "./sql-query-sidebar";
import { SqlQuerySidebar, TEMPLATES } from "./sql-query-sidebar";
import { referencedTables, useSqlSchema } from "./sql-schema";
import type { SqlTab } from "./sql-tabs";
import { addTab, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, isDirty, makeTab, MAX_TABS, tabsClosedBy, usePersistedTabs } from "./sql-tabs";

/** Which bulk close the tab context menu is offering / confirming. */
type BulkClose = "all" | "others" | "right";

interface SqlEditorPanelProps {
    /** Shard key the query runs against on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);
const STORAGE_KEY = "cirrus-studio-sql-queries";
const HISTORY_KEY = "cirrus-studio-sql-history";
/** How many recent distinct queries the history keeps. */
const HISTORY_LIMIT = 25;
/** Line-number gutter sizing, aligned to the editor textarea's padding + line height. */
const GUTTER_STYLE: CSSProperties = { minWidth: "2.75rem", paddingInline: "0.5rem" };
/** Which results sub-pane is shown. */
type ResultTab = "chart" | "explain" | "results";

/**
 * One editor tab's ephemeral output — the last run's result/error plus which result
 * pane is shown. Kept as a single per-tab record (not three parallel maps) so a
 * write touches one entry and closing a tab is one `delete`.
 */
interface TabOutput {
    readonly error: null | string;
    readonly pane: ResultTab;
    readonly result: null | SqlConsoleResult;
}

/** A tab's output before it has run anything. */
const DEFAULT_TAB_OUTPUT: TabOutput = { error: null, pane: "results", result: null };

interface TabButtonProps {
    readonly active: boolean;
    readonly canClose: boolean;
    readonly onClose: (id: string) => void;
    readonly onMenu: (id: string, event: React.MouseEvent) => void;
    readonly onRename: (id: string, name: string) => void;
    readonly onSelect: (id: string) => void;
    readonly tab: SqlTab;
}

/** The auto-derived tab label when the operator hasn't set a custom name: the draft's first line, or "Untitled". */
const derivedTabLabel = (sql: string, untitled: string): string => (sql.trim() === "" ? untitled : (sql.split("\n")[0] ?? sql).slice(0, 24));

/**
 * One editor tab in the strip: a label that selects it (double-click to rename
 * it in place) plus a close affordance (hidden for the sole tab). The label is
 * the operator's custom `tab.name` when set, else a preview derived from the draft.
 */
const TabButton = ({ active, canClose, onClose, onMenu, onRename, onSelect, tab }: TabButtonProps): ReactElement => {
    const t = useT();
    const [editing, setEditing] = useState<boolean>(false);
    const [confirmingClose, setConfirmingClose] = useState<boolean>(false);
    const onContextMenu = useCallback(
        (event: React.MouseEvent): void => {
            onMenu(tab.id, event);
        },
        [onMenu, tab.id],
    );

    // Only an unlinked scratch draft with text holds unsaved work worth confirming.
    const dirty = isDirty(tab);

    // Callback ref: focus + select the title the moment the inline editor mounts
    // (replaces `autoFocus`, and fires once on open rather than every render).
    const focusOnMount = useCallback((node: HTMLInputElement | null): void => {
        node?.focus();
        node?.select();
    }, []);

    const onClick = useCallback((): void => {
        onSelect(tab.id);
    }, [onSelect, tab.id]);
    const onCloseClick = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();

            // Guard an unsaved draft behind the inline confirm; close the rest outright.
            if (dirty) {
                setConfirmingClose(true);
            } else {
                onClose(tab.id);
            }
        },
        [dirty, onClose, tab.id],
    );
    const confirmClose = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();
            setConfirmingClose(false);
            onClose(tab.id);
        },
        [onClose, tab.id],
    );
    const cancelClose = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        setConfirmingClose(false);
    }, []);

    const startEditing = useCallback((): void => {
        setEditing(true);
    }, []);

    // Commit the edited title (trimmed; blank reverts the tab to its derived label),
    // then leave edit mode. Esc cancels without committing.
    const commitRename = useCallback(
        (event: React.FocusEvent<HTMLInputElement> | React.KeyboardEvent<HTMLInputElement>): void => {
            onRename(tab.id, event.currentTarget.value.trim());
            setEditing(false);
        },
        [onRename, tab.id],
    );
    const onRenameKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>): void => {
            if (event.key === "Enter") {
                commitRename(event);
            } else if (event.key === "Escape") {
                setEditing(false);
            }
        },
        [commitRename],
    );

    const custom = tab.name.trim();
    const label = custom === "" ? derivedTabLabel(tab.sql, t("Untitled")) : custom;

    return (
        <div
            className={cn(
                "group/tab flex shrink-0 items-center gap-1 border-e border-border ps-3 pe-1.5 text-xs",
                active ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
            data-testid={`sql-tab-${tab.id}`}
            onContextMenu={onContextMenu}
        >
            {editing ? (
                <input
                    aria-label={t("Tab title")}
                    className="w-40 rounded border border-ring bg-background px-1 py-0.5 text-xs outline-none"
                    data-testid={`sql-tab-rename-${tab.id}`}
                    defaultValue={custom}
                    onBlur={commitRename}
                    onKeyDown={onRenameKeyDown}
                    placeholder={derivedTabLabel(tab.sql, t("Untitled"))}
                    ref={focusOnMount}
                    type="text"
                />
            ) : (
                <button
                    aria-pressed={active}
                    className="max-w-40 truncate py-1.5 outline-none"
                    data-testid={`sql-tab-select-${tab.id}`}
                    onClick={onClick}
                    onDoubleClick={startEditing}
                    title={t("Double-click to rename")}
                    type="button"
                >
                    {label}
                </button>
            )}
            {canClose &&
                (confirmingClose ? (
                    <span className="flex shrink-0 items-center gap-1" data-testid={`sql-tab-close-prompt-${tab.id}`} role="group">
                        <span className="text-[11px] text-muted-foreground">{t("Discard?")}</span>
                        <button
                            aria-label={t("Discard changes")}
                            className="flex size-5 items-center justify-center rounded text-destructive hover:bg-destructive/10"
                            data-testid={`sql-tab-close-confirm-${tab.id}`}
                            onClick={confirmClose}
                            title={t("Discard changes")}
                            type="button"
                        >
                            <svg
                                aria-hidden="true"
                                className="size-3"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2.4}
                                viewBox="0 0 24 24"
                            >
                                <path d="M5 13l4 4L19 7" />
                            </svg>
                        </button>
                        <button
                            aria-label={t("Keep editing")}
                            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                            data-testid={`sql-tab-close-cancel-${tab.id}`}
                            onClick={cancelClose}
                            title={t("Keep editing")}
                            type="button"
                        >
                            <svg
                                aria-hidden="true"
                                className="size-3"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2.4}
                                viewBox="0 0 24 24"
                            >
                                <path d="M6 6l12 12M18 6 6 18" />
                            </svg>
                        </button>
                    </span>
                ) : (
                    <button
                        aria-label={t("Close tab")}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        data-testid={`sql-tab-close-${tab.id}`}
                        onClick={onCloseClick}
                        title={t("Close tab")}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-3"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            viewBox="0 0 24 24"
                        >
                            <path d="M6 6l12 12M18 6 6 18" />
                        </svg>
                    </button>
                ))}
        </div>
    );
};

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
 * Read-only — the `__cirrus_admin__:runSql` RPC rejects everything but
 * SELECT / WITH / EXPLAIN, so raw writes can't desync the doc-store's shadow
 * tables (use the Data grid's inline edit for mutations).
 */
export const SqlEditorPanel = ({ initialShardKey }: SqlEditorPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [queries, setQueries] = usePersistedList<SavedQuery>(STORAGE_KEY);
    const [history, setHistory] = usePersistedList<HistoryEntry>(HISTORY_KEY);
    const [search, setSearch] = useState<string>("");

    // Multiple editor tabs: each persisted tab owns its draft + the saved-query
    // it mirrors; the result/error/pane are kept per tab in ephemeral maps so a
    // reload restores the open tabs (and their text) but re-runs for results.
    const seedTab = useCallback((): SqlTab => makeTab(TEMPLATES[0]?.sql ?? ""), []);
    const { activeId: activeTabId, setActiveId: setActiveTabId, setTabs, tabs } = usePersistedTabs(seedTab);

    // One ephemeral output record per tab id (result + error + result-pane). Not
    // persisted, so a reload restores the open tabs and their text but re-runs for
    // results. Closing a tab deletes its entry — no stale keys accumulate.
    const [outputs, setOutputs] = useState<Record<string, TabOutput>>({});

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [running, setRunning] = useState<boolean>(false);
    // The right-clicked tab's context menu: the target tab id + cursor position, or null when closed.
    const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
    // The bulk close awaiting a discard confirm (because it would drop unsaved tabs), or null.
    const [pendingBulk, setPendingBulk] = useState<BulkClose | null>(null);

    const gutterRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<HTMLTextAreaElement | null>(null);
    const privateListRef = useRef<HTMLUListElement | null>(null);
    const listboxId = useId();

    const { probe, schema } = useSqlSchema(shardKey);

    // The active tab is the source of truth for the editor's draft + saved-query
    // link; `result`/`error`/`tab` read out of the per-tab ephemeral maps.
    const activeTab = useMemo<SqlTab>(() => tabs.find((each) => each.id === activeTabId) ?? tabs[0] ?? makeTab(), [activeTabId, tabs]);
    const draft = activeTab.sql;
    const { activeId } = activeTab;
    const output = outputs[activeTab.id] ?? DEFAULT_TAB_OUTPUT;
    const { error, result } = output;
    const tab = output.pane;

    // Patch the active tab's persisted fields (draft text and/or saved-query link).
    const patchActiveTab = useCallback(
        (patch: Partial<Pick<SqlTab, "activeId" | "sql">>): void => {
            setTabs((current) => current.map((each) => (each.id === activeTab.id ? { ...each, ...patch } : each)));
        },
        [activeTab.id, setTabs],
    );

    // Replace the active tab's ephemeral result/error/pane in one shot. An omitted
    // `pane` keeps whatever pane was showing (defaulting to "results").
    const setActiveOutput = useCallback(
        (next: { error: null | string; pane?: ResultTab; result: null | SqlConsoleResult }): void => {
            setOutputs((current) => {
                const previous = current[activeTab.id] ?? DEFAULT_TAB_OUTPUT;

                return { ...current, [activeTab.id]: { error: next.error, pane: next.pane ?? previous.pane, result: next.result } };
            });
        },
        [activeTab.id],
    );

    // Switch the active tab's result pane (Results/Chart) without touching its rows.
    const setActivePane = useCallback(
        (pane: ResultTab): void => {
            setOutputs((current) => {
                const previous = current[activeTab.id] ?? DEFAULT_TAB_OUTPUT;

                return { ...current, [activeTab.id]: { ...previous, pane } };
            });
        },
        [activeTab.id],
    );

    // Set the active tab's draft and keep the linked saved query in sync (auto-save).
    const setDraft = useCallback(
        (value: string): void => {
            patchActiveTab({ sql: value });

            if (activeId !== null) {
                setQueries((current) => current.map((query) => (query.id === activeId ? { ...query, sql: value } : query)));
            }
        },
        [activeId, patchActiveTab, setQueries],
    );

    const autocomplete = useSqlAutocomplete(schema, editorRef, setDraft);
    const {
        close: closeAutocomplete,
        commit: commitAutocomplete,
        move: moveAutocomplete,
        refresh: refreshAutocomplete,
        state: autocompleteState,
    } = autocomplete;

    // Pick the suggestion at `index` from the mouse path (mirror the keyboard commit).
    const onPickSuggestion = useCallback(
        (index: number): void => {
            moveAutocomplete(index - (autocompleteState?.active ?? 0));
            commitAutocomplete();
        },
        [autocompleteState?.active, commitAutocomplete, moveAutocomplete],
    );

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
    const recordHistory = useCallback(
        (sql: string): void => {
            setHistory((current) => {
                if (current[0]?.sql === sql) {
                    return current;
                }

                const next: HistoryEntry[] = [{ at: Date.now(), sql }, ...current.filter((entry) => entry.sql !== sql)];

                return next.slice(0, HISTORY_LIMIT);
            });
        },
        [setHistory],
    );

    const run = useCallback(
        async (mode: ResultTab): Promise<void> => {
            if (draft.trim() === "") {
                return;
            }

            setRunning(true);
            const sql = mode === "explain" ? `EXPLAIN QUERY PLAN ${draft}` : draft;

            try {
                const next = (await client.query(RUN_SQL, { sql }, callOptions(shardKey))) as SqlConsoleResult;

                setActiveOutput({ error: null, pane: mode, result: next });
                recordShard(shardKey);
                recordHistory(sql);
            } catch (error_: unknown) {
                setActiveOutput({ error: errorMessage(error_), pane: mode, result: null });
            } finally {
                setRunning(false);
            }
        },
        [client, draft, recordHistory, setActiveOutput, shardKey],
    );

    const onRun = useCallback((): void => {
        fireAndForget(run("results"));
    }, [run]);

    // Edit the draft (auto-saving the linked query) and re-derive completions
    // from the new caret position, pre-probing any table the draft now names.
    const onDraftChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
            const { selectionStart, value } = event.target;

            setDraft(value);

            for (const table of referencedTables(value)) {
                probe(table);
            }

            refreshAutocomplete(value, selectionStart);
        },
        [probe, refreshAutocomplete, setDraft],
    );

    // Re-derive completions when the caret moves without an edit (arrow keys, click).
    const onEditorSelect = useCallback(
        (event: React.SyntheticEvent<HTMLTextAreaElement>): void => {
            const node = event.currentTarget;

            refreshAutocomplete(node.value, node.selectionStart);
        },
        [refreshAutocomplete],
    );

    const onEditorKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
        },
        [autocompleteState, closeAutocomplete, commitAutocomplete, moveAutocomplete, run, tab],
    );

    const onEditorBlur = useCallback((): void => {
        // Defer so a mousedown-pick on a suggestion still resolves before close.
        requestAnimationFrame(() => {
            closeAutocomplete();
        });
    }, [closeAutocomplete]);

    // Keep the line-number gutter aligned with the textarea's scroll.
    const onEditorScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>): void => {
        if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }
    }, []);

    // Load `sql` into the active tab as a fresh draft, link it to `savedId` (or
    // unlink with `null`), and clear that tab's stale result/error.
    const loadIntoActiveTab = useCallback(
        (sql: string, savedId: null | string): void => {
            setTabs((current) => current.map((each) => (each.id === activeTab.id ? { ...each, activeId: savedId, sql } : each)));
            setActiveOutput({ error: null, result: null });
        },
        [activeTab.id, setActiveOutput, setTabs],
    );

    const newQuery = useCallback((): void => {
        const query: SavedQuery = { id: newId("q"), name: t("Untitled query"), sql: "" };

        setQueries((current) => [query, ...current]);
        loadIntoActiveTab("", query.id);
    }, [loadIntoActiveTab, setQueries, t]);

    const selectQuery = useCallback(
        (id: string): void => {
            const found = queries.find((query) => query.id === id);

            if (found !== undefined) {
                loadIntoActiveTab(found.sql, id);
                // Reveal the loaded query in the (possibly scrolled) Private list so the
                // operator sees which one is now active.
                privateListRef.current?.querySelector(`[data-testid="sql-query-${id}"]`)?.scrollIntoView({ block: "nearest" });
            }
        },
        [loadIntoActiveTab, queries],
    );

    const deleteQuery = useCallback(
        (id: string): void => {
            setQueries((current) => current.filter((query) => query.id !== id));
            // Unlink any tab that was editing the deleted query.
            setTabs((current) => current.map((each) => (each.activeId === id ? { ...each, activeId: null } : each)));
        },
        [setQueries, setTabs],
    );

    const loadTemplate = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            loadIntoActiveTab(event.currentTarget.dataset.sql ?? "", null);
        },
        [loadIntoActiveTab],
    );

    // Load a past run back into the editor as a fresh draft (not a saved query).
    const loadFromHistory = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            loadIntoActiveTab(event.currentTarget.dataset.sql ?? "", null);
        },
        [loadIntoActiveTab],
    );

    const clearHistory = useCallback((): void => {
        setHistory([]);
    }, [setHistory]);

    // Pretty-print the current draft in place (auto-saving the active query too).
    const formatDraft = useCallback((): void => {
        setDraft(formatSql(draft));
    }, [draft, setDraft]);

    // Add a new empty tab and switch to it (no-op once MAX_TABS are open).
    const addEditorTab = useCallback((): void => {
        if (tabs.length >= MAX_TABS) {
            return;
        }

        const fresh = makeTab();

        setTabs((current) => addTab(current, fresh));
        setActiveTabId(fresh.id);
    }, [setActiveTabId, setTabs, tabs.length]);

    // Commit a new tab set + active id, pruning ephemeral output down to the
    // surviving tabs so dead keys can't accumulate over a session. Shared by the
    // single close and the bulk close-others / close-to-right / close-all paths.
    const commitTabs = useCallback(
        (next: { activeId: string; tabs: SqlTab[] }): void => {
            setTabMenu(null);
            setPendingBulk(null);
            setTabs(next.tabs);
            setActiveTabId(next.activeId);

            const openIds = new Set(next.tabs.map((each) => each.id));

            setOutputs((current) => Object.fromEntries(Object.entries(current).filter(([key]) => openIds.has(key))));
        },
        [setActiveTabId, setTabs],
    );

    const closeEditorTab = useCallback(
        (id: string): void => {
            commitTabs(closeTab(tabs, id, makeTab));
        },
        [commitTabs, tabs],
    );

    // Apply a bulk close (the dirty-tab guard is handled by the caller).
    const applyBulk = useCallback(
        (op: BulkClose, id: string): void => {
            if (op === "others") {
                commitTabs(closeOtherTabs(tabs, id));
            } else if (op === "right") {
                commitTabs(closeTabsToRight(tabs, id, activeTabId));
            } else {
                commitTabs(closeAllTabs(makeTab));
            }
        },
        [activeTabId, commitTabs, tabs],
    );

    // Run a bulk close, but route it through an inline discard confirm first when
    // it would drop a tab with unsaved work (matching the single-close guard).
    const requestBulk = useCallback(
        (op: BulkClose): void => {
            if (tabMenu === null) {
                return;
            }

            if (tabsClosedBy(op, tabs, tabMenu.id).some((each) => isDirty(each))) {
                setPendingBulk(op);
            } else {
                applyBulk(op, tabMenu.id);
            }
        },
        [applyBulk, tabMenu, tabs],
    );

    // Open the tab context menu at the cursor for the right-clicked tab.
    const openTabMenu = useCallback((id: string, event: React.MouseEvent): void => {
        event.preventDefault();
        setPendingBulk(null);
        setTabMenu({ id, x: event.clientX, y: event.clientY });
    }, []);

    const closeTabMenu = useCallback((): void => {
        setTabMenu(null);
        setPendingBulk(null);
    }, []);
    const onBackdropContextMenu = useCallback((event: React.MouseEvent): void => {
        event.preventDefault();
        setTabMenu(null);
        setPendingBulk(null);
    }, []);
    const onCloseOthers = useCallback((): void => {
        requestBulk("others");
    }, [requestBulk]);
    const onCloseToRight = useCallback((): void => {
        requestBulk("right");
    }, [requestBulk]);
    const onCloseAll = useCallback((): void => {
        requestBulk("all");
    }, [requestBulk]);
    const confirmBulk = useCallback((): void => {
        if (tabMenu !== null && pendingBulk !== null) {
            applyBulk(pendingBulk, tabMenu.id);
        }

        setPendingBulk(null);
    }, [applyBulk, pendingBulk, tabMenu]);
    const cancelBulk = useCallback((): void => {
        setPendingBulk(null);
    }, []);
    const tabMenuStyle = useMemo(() => (tabMenu === null ? undefined : { left: tabMenu.x, top: tabMenu.y }), [tabMenu]);

    const selectTab = useCallback(
        (id: string): void => {
            closeAutocomplete();
            setActiveTabId(id);
        },
        [closeAutocomplete, setActiveTabId],
    );

    // Set a tab's custom title (blank reverts it to the draft-derived label).
    const renameTab = useCallback(
        (id: string, name: string): void => {
            setTabs((current) => current.map((each) => (each.id === id ? { ...each, name } : each)));
        },
        [setTabs],
    );

    const showResults = useCallback((): void => {
        setActivePane("results");
    }, [setActivePane]);

    const showExplain = useCallback((): void => {
        fireAndForget(run("explain"));
    }, [run]);

    const showChart = useCallback((): void => {
        setActivePane("chart");
    }, [setActivePane]);

    const lineCount = useMemo<number>(() => draft.split("\n").length, [draft]);
    const onSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    }, []);

    const tabClass = (selected: boolean): string =>
        `border-b-2 px-3 py-2 text-sm outline-none transition-colors ${selected ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-sql-editor">
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

                {/* Line-numbered editor pane. */}
                <div className="flex min-h-0 flex-1">
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
                    <div className="relative min-w-0 flex-1">
                        <textarea
                            aria-activedescendant={autocompleteState === null ? undefined : `${listboxId}-opt-${autocompleteState.active.toString()}`}
                            aria-autocomplete="list"
                            aria-controls={autocompleteState === null ? undefined : listboxId}
                            aria-expanded={autocompleteState !== null}
                            aria-label={t("SQL query")}
                            className="size-full resize-none bg-background p-3 font-mono text-xs leading-5 outline-none"
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

                {/* Results pane. */}
                <div className="flex h-2/5 min-h-0 shrink-0 flex-col border-t border-border">
                    <div className="flex shrink-0 items-center gap-2 border-b border-border pe-2">
                        <button className={tabClass(tab === "results")} data-testid="sql-tab-results" onClick={showResults} type="button">
                            {t("Results")}
                        </button>
                        <button className={tabClass(tab === "chart")} data-testid="sql-tab-chart" onClick={showChart} type="button">
                            {t("Chart")}
                        </button>
                        <button className={tabClass(tab === "explain")} data-testid="sql-tab-explain" onClick={showExplain} type="button">
                            {t("Explain")}
                        </button>
                        <div className="ms-auto flex items-center gap-2">
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
                                {tab === "chart" ? <SqlResultChart result={result} /> : <SqlResultTable result={result} />}
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
    );
};

export type { SqlEditorPanelProps };
