import { useCirrus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import SqlResultChart from "../../components/result-chart";
import { ShardInput } from "../../components/shard-input";
import { Alert } from "../../components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import type { SqlConsoleResult, TableInfo, TablePage } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { newId, usePersistedList } from "../../lib/browser-storage";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import { CellValue } from "../data/data-grid";
import { ExportMenu } from "../data/grid-features";
import formatSql from "./format-sql";
import type { SqlSchema } from "./sql-autocomplete";
import { AutocompletePopover, useSqlAutocomplete } from "./sql-autocomplete-ui";
import type { SqlTab } from "./sql-tabs";
import { addTab, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, makeTab, MAX_TABS, usePersistedTabs } from "./sql-tabs";

interface SqlEditorPanelProps {
    /** Shard key the query runs against on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** One browser-persisted query in the editor's PRIVATE list. */
interface SavedQuery {
    readonly id: string;
    readonly name: string;
    readonly sql: string;
}

/** Canned reference queries that load into the editor as a new draft. */
interface QueryTemplate {
    readonly label: string;
    readonly sql: string;
}

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);
const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
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

const TEMPLATES: ReadonlyArray<QueryTemplate> = [
    { label: "List tables", sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;" },
    { label: "Table row count", sql: "SELECT COUNT(*) AS rows FROM messages;" },
    { label: "Recent rows", sql: "SELECT id, _creationTime, __doc__ FROM messages ORDER BY _creationTime DESC LIMIT 50;" },
    { label: "Index list", sql: "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name;" },
];

/** One run recorded in the browser-local query history. */
interface HistoryEntry {
    /** Epoch milliseconds the query was run. */
    readonly at: number;
    /** The executed SQL string. */
    readonly sql: string;
}

interface QueryRowProps {
    readonly active: boolean;
    readonly onDelete: (id: string) => void;
    readonly onSelect: (id: string) => void;
    readonly query: SavedQuery;
}

/** One saved-query row in the PRIVATE list: select on click, delete on the trailing button. */
const QueryRow = ({ active, onDelete, onSelect, query }: QueryRowProps): ReactElement => {
    const t = useT();
    const onClick = useCallback((): void => {
        onSelect(query.id);
    }, [onSelect, query.id]);
    const onDeleteClick = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();
            onDelete(query.id);
        },
        [onDelete, query.id],
    );

    return (
        <li className="group/q flex items-center">
            <button
                aria-pressed={active}
                className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                    active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground",
                )}
                data-testid={`sql-query-${query.id}`}
                onClick={onClick}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    className="size-3.5 shrink-0 opacity-70"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.6}
                    viewBox="0 0 24 24"
                >
                    <path d="M4 6h16M4 12h10M4 18h7" />
                </svg>
                <span className="truncate">{query.name}</span>
            </button>
            <button
                aria-label={t("Delete query")}
                className="me-1 hidden size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover/q:flex"
                onClick={onDeleteClick}
                title={t("Delete query")}
                type="button"
            >
                <svg
                    aria-hidden="true"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.6}
                    viewBox="0 0 24 24"
                >
                    <path d="M5 7h14M9 7V5h6v2m-1 0v12H10V7M7 7v13h10V7" />
                </svg>
            </button>
        </li>
    );
};

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

    // A tab holds unsaved work only when it's an unlinked scratch draft with
    // text — a linked tab auto-saves to its query, and an empty tab loses
    // nothing — so only those prompt before closing.
    const dirty = tab.activeId === null && tab.sql.trim() !== "";

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
 * Load the shard's table names (and, lazily, each table's columns) to feed the
 * editor's autocomplete. Tables come from one `listTables`; columns are probed
 * per table with a one-row `readTablePage` (the same RPC the schema viewer
 * uses) the first time the operator types a `tbl.` qualifier or otherwise needs
 * them — so an unexplored schema still completes table names without N probes
 * up front. All best-effort: a failed probe simply leaves that table's columns
 * absent. Re-loads when `shardKey` changes; a fast shard switch discards a stale
 * in-flight list via the cancel token.
 */
const useSqlSchema = (shardKey: string): { probe: (table: string) => void; schema: SqlSchema } => {
    const client = useCirrus();

    const [tables, setTables] = useState<string[]>([]);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    // Tables a probe has already been kicked off for, so `probe` is idempotent
    // without nesting the fetch inside a setState updater. Cleared on shard switch.
    const probed = useRef<Set<string>>(new Set());

    useEffect(() => {
        const token = { cancelled: false };

        const load = async (): Promise<void> => {
            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shardKey))) as TableInfo[];

                if (!token.cancelled) {
                    setTables(result.map((table) => table.name));
                    setColumns({});
                    probed.current = new Set();
                }
            } catch {
                if (!token.cancelled) {
                    setTables([]);
                    setColumns({});
                    probed.current = new Set();
                }
            }
        };

        fireAndForget(load());

        return () => {
            token.cancelled = true;
        };
    }, [client, shardKey]);

    // Fetch one table's columns once, on demand; a failure leaves it un-probed so
    // a later call can retry. Keyed by table only — the effect above resets the
    // cache on a shard switch, so a stale shard's columns can't bleed through.
    const probe = useCallback(
        (table: string): void => {
            if (probed.current.has(table)) {
                return;
            }

            probed.current.add(table);

            const fetchColumns = async (): Promise<void> => {
                try {
                    const page = (await client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shardKey))) as TablePage;

                    setColumns((previous) => {
                        return { ...previous, [table]: page.columns };
                    });
                } catch {
                    // Best-effort: drop the in-flight marker so a later probe can retry.
                    probed.current.delete(table);
                }
            };

            fireAndForget(fetchColumns());
        },
        [client, shardKey],
    );

    const schema = useMemo<SqlSchema>(() => {
        return { columns, tables };
    }, [columns, tables]);

    return { probe, schema };
};

/** Table names referenced in `sql` after `FROM`/`JOIN`/`UPDATE`/`INTO`, or as a `tbl.` qualifier. */
const TABLE_REF = /\b(?:from|join|update|into)\s+([a-z_][\w$]*)|\b([a-z_][\w$]*)\s*\./gi;

/** Mentioned table names in a draft, so the schema hook can pre-probe their columns for column completion. */
const referencedTables = (sql: string): string[] => {
    const names = new Set<string>();

    TABLE_REF.lastIndex = 0;
    let match: null | RegExpExecArray = TABLE_REF.exec(sql);

    while (match !== null) {
        names.add((match[1] ?? match[2]) as string);
        match = TABLE_REF.exec(sql);
    }

    return [...names];
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

    const closeOthers = useCallback(
        (id: string): void => {
            commitTabs(closeOtherTabs(tabs, id));
        },
        [commitTabs, tabs],
    );

    const closeToRight = useCallback(
        (id: string): void => {
            commitTabs(closeTabsToRight(tabs, id, activeTabId));
        },
        [activeTabId, commitTabs, tabs],
    );

    const closeAll = useCallback((): void => {
        commitTabs(closeAllTabs(makeTab));
    }, [commitTabs]);

    // Open the tab context menu at the cursor for the right-clicked tab.
    const openTabMenu = useCallback((id: string, event: React.MouseEvent): void => {
        event.preventDefault();
        setTabMenu({ id, x: event.clientX, y: event.clientY });
    }, []);

    const closeTabMenu = useCallback((): void => {
        setTabMenu(null);
    }, []);
    const onBackdropContextMenu = useCallback((event: React.MouseEvent): void => {
        event.preventDefault();
        setTabMenu(null);
    }, []);
    const onCloseOthers = useCallback((): void => {
        if (tabMenu !== null) {
            closeOthers(tabMenu.id);
        }
    }, [closeOthers, tabMenu]);
    const onCloseToRight = useCallback((): void => {
        if (tabMenu !== null) {
            closeToRight(tabMenu.id);
        }
    }, [closeToRight, tabMenu]);
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

    const filtered = useMemo<SavedQuery[]>(() => {
        const needle = search.trim().toLowerCase();

        return needle === "" ? queries : queries.filter((query) => query.name.toLowerCase().includes(needle));
    }, [queries, search]);

    const lineCount = useMemo<number>(() => draft.split("\n").length, [draft]);
    const onSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    }, []);

    const tabClass = (selected: boolean): string =>
        `border-b-2 px-3 py-2 text-sm outline-none transition-colors ${selected ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-sql-editor">
            {/* Query sidebar. */}
            <aside className="flex h-full w-64 shrink-0 flex-col border-e border-border bg-sidebar">
                <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
                    <input
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:border-ring"
                        data-testid="sql-search"
                        onChange={onSearchChange}
                        placeholder={t("Search queries…")}
                        type="text"
                        value={search}
                    />
                    <button
                        aria-label={t("New query")}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        data-testid="sql-new"
                        onClick={newQuery}
                        title={t("New query")}
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

                <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
                    <div>
                        <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("Private")}</p>
                        {filtered.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-muted-foreground" data-testid="sql-private-empty">
                                {t("No saved queries yet — they save to this browser as you type.")}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-px" data-testid="sql-private" ref={privateListRef}>
                                {filtered.map((query) => (
                                    <QueryRow active={activeId === query.id} key={query.id} onDelete={deleteQuery} onSelect={selectQuery} query={query} />
                                ))}
                            </ul>
                        )}
                    </div>

                    <div>
                        <p className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("Reference")}</p>
                        <ul className="flex flex-col gap-px">
                            {TEMPLATES.map((template) => (
                                <li key={template.label}>
                                    <button
                                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent"
                                        data-sql={template.sql}
                                        onClick={loadTemplate}
                                        type="button"
                                    >
                                        <svg
                                            aria-hidden="true"
                                            className="size-3.5 shrink-0 opacity-70"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={1.6}
                                            viewBox="0 0 24 24"
                                        >
                                            <path d="M7 4h7l4 4v12H7zM14 4v4h4" />
                                        </svg>
                                        {template.label}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {history.length > 0 && (
                        <div>
                            <div className="flex items-center justify-between px-1 pb-1">
                                <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("History")}</p>
                                <button
                                    className="rounded px-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                                    data-testid="sql-history-clear"
                                    onClick={clearHistory}
                                    type="button"
                                >
                                    {t("Clear history")}
                                </button>
                            </div>
                            <ul className="flex flex-col gap-px" data-testid="sql-history">
                                {history.map((entry) => (
                                    <li key={`${entry.at.toString()}:${entry.sql}`}>
                                        <button
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent"
                                            data-sql={entry.sql}
                                            data-testid="sql-history-item"
                                            onClick={loadFromHistory}
                                            title={entry.sql}
                                            type="button"
                                        >
                                            <svg
                                                aria-hidden="true"
                                                className="size-3.5 shrink-0 opacity-70"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={1.6}
                                                viewBox="0 0 24 24"
                                            >
                                                <path d="M12 8v4l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" />
                                            </svg>
                                            <span className="truncate font-mono">{entry.sql}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </aside>

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
                                onClick={closeAll}
                                role="menuitem"
                                type="button"
                            >
                                {t("Close all tabs")}
                            </button>
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
