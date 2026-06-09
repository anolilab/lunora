import { useCirrus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SqlConsoleResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { CellValue } from "./data-grid";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";

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
const STORAGE_KEY = "cirrus-studio-sql-queries";
/** Line-number gutter sizing, aligned to the editor textarea's padding + line height. */
const GUTTER_STYLE: CSSProperties = { minWidth: "2.75rem", paddingInline: "0.5rem" };
/** Which results sub-pane is shown. */
type ResultTab = "explain" | "results";

const TEMPLATES: ReadonlyArray<QueryTemplate> = [
    { label: "List tables", sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;" },
    { label: "Table row count", sql: "SELECT COUNT(*) AS rows FROM messages;" },
    { label: "Recent rows", sql: "SELECT id, _creationTime, __doc__ FROM messages ORDER BY _creationTime DESC LIMIT 50;" },
    { label: "Index list", sql: "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name;" },
];

/** Read the persisted query list (browser-local, best-effort). */
const loadQueries = (): SavedQuery[] => {
    if (!("localStorage" in globalThis)) {
        return [];
    }

    try {
        const raw = globalThis.localStorage.getItem(STORAGE_KEY);
        const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);

        return Array.isArray(parsed) ? (parsed as SavedQuery[]) : [];
    } catch {
        return [];
    }
};

/** A best-effort unique id for a new saved query. */
const newId = (): string =>
    (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ?? `q-${globalThis.performance.now().toString(36)}`;

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
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent ${active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground"}`}
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

    const [queries, setQueries] = useState<SavedQuery[]>(loadQueries);
    const [activeId, setActiveId] = useState<null | string>(null);
    const [draft, setDraft] = useState<string>(TEMPLATES[0]?.sql ?? "");
    const [search, setSearch] = useState<string>("");

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tab, setTab] = useState<ResultTab>("results");
    const [result, setResult] = useState<null | SqlConsoleResult>(null);
    const [error, setError] = useState<null | string>(null);
    const [running, setRunning] = useState<boolean>(false);

    const gutterRef = useRef<HTMLDivElement | null>(null);

    // Persist the query list to the browser whenever it changes.
    useEffect(() => {
        if ("localStorage" in globalThis) {
            globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
        }
    }, [queries]);

    const run = useCallback(
        async (mode: ResultTab): Promise<void> => {
            if (draft.trim() === "") {
                return;
            }

            setRunning(true);
            const sql = mode === "explain" ? `EXPLAIN QUERY PLAN ${draft}` : draft;

            try {
                const next = (await client.query(RUN_SQL, { sql }, callOptions(shardKey))) as SqlConsoleResult;

                setResult(next);
                setError(null);
                setTab(mode);
                recordShard(shardKey);
            } catch (error_: unknown) {
                setResult(null);
                setError(errorMessage(error_));
                setTab(mode);
            } finally {
                setRunning(false);
            }
        },
        [client, draft, shardKey],
    );

    const onRun = useCallback((): void => {
        fireAndForget(run("results"));
    }, [run]);

    // Edit the draft and keep the active saved query in sync (auto-save).
    const onDraftChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
            const { value } = event.target;

            setDraft(value);

            if (activeId !== null) {
                setQueries((current) => current.map((query) => (query.id === activeId ? { ...query, sql: value } : query)));
            }
        },
        [activeId],
    );

    const onEditorKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                fireAndForget(run(tab));
            }
        },
        [run, tab],
    );

    // Keep the line-number gutter aligned with the textarea's scroll.
    const onEditorScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>): void => {
        if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
        }
    }, []);

    const newQuery = useCallback((): void => {
        const query: SavedQuery = { id: newId(), name: t("Untitled query"), sql: "" };

        setQueries((current) => [query, ...current]);
        setActiveId(query.id);
        setDraft("");
        setResult(null);
        setError(null);
    }, [t]);

    const selectQuery = useCallback(
        (id: string): void => {
            const found = queries.find((query) => query.id === id);

            if (found !== undefined) {
                setActiveId(id);
                setDraft(found.sql);
                setResult(null);
                setError(null);
            }
        },
        [queries],
    );

    const deleteQuery = useCallback(
        (id: string): void => {
            setQueries((current) => current.filter((query) => query.id !== id));

            if (activeId === id) {
                setActiveId(null);
            }
        },
        [activeId],
    );

    const loadTemplate = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        const sql = event.currentTarget.dataset.sql ?? "";

        setActiveId(null);
        setDraft(sql);
        setResult(null);
        setError(null);
    }, []);

    const showResults = useCallback((): void => {
        setTab("results");
    }, []);

    const showExplain = useCallback((): void => {
        fireAndForget(run("explain"));
    }, [run]);

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
                            <ul className="flex flex-col gap-px" data-testid="sql-private">
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
                </div>
            </aside>

            {/* Editor + results. */}
            <div className="flex min-w-0 flex-1 flex-col">
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
                    <textarea
                        aria-label={t("SQL query")}
                        className="min-w-0 flex-1 resize-none bg-background p-3 font-mono text-xs leading-5 outline-none"
                        data-testid="sql-input"
                        onChange={onDraftChange}
                        onKeyDown={onEditorKeyDown}
                        onScroll={onEditorScroll}
                        placeholder="SELECT * FROM …"
                        spellCheck={false}
                        value={draft}
                    />
                </div>

                {/* Results pane. */}
                <div className="flex h-2/5 min-h-0 shrink-0 flex-col border-t border-border">
                    <div className="flex shrink-0 items-center gap-2 border-b border-border pe-2">
                        <button className={tabClass(tab === "results")} data-testid="sql-tab-results" onClick={showResults} type="button">
                            {t("Results")}
                        </button>
                        <button className={tabClass(tab === "explain")} data-testid="sql-tab-explain" onClick={showExplain} type="button">
                            {t("Explain")}
                        </button>
                        <div className="ms-auto flex items-center gap-2">
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
                            <p
                                className="m-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
                                data-testid="sql-error"
                                role="alert"
                            >
                                {error}
                            </p>
                        )}

                        {error === null && result === null && (
                            <p className="p-4 text-sm text-muted-foreground" data-testid="sql-empty">
                                {t("Click Run to execute your query.")}
                            </p>
                        )}

                        {error === null && result !== null && (
                            <div data-testid="sql-result">
                                <SqlResultTable result={result} />
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
