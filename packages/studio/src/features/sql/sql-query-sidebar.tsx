import type { ChangeEvent, MouseEvent, ReactElement, RefObject } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";

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

/** One run recorded in the browser-local query history. */
interface HistoryEntry {
    /** Epoch milliseconds the query was run. */
    readonly at: number;
    /** The executed SQL string. */
    readonly sql: string;
}

const TEMPLATES: ReadonlyArray<QueryTemplate> = [
    { label: "List tables", sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;" },
    { label: "Table row count", sql: "SELECT COUNT(*) AS rows FROM messages;" },
    { label: "Recent rows", sql: "SELECT id, _creationTime, __doc__ FROM messages ORDER BY _creationTime DESC LIMIT 50;" },
    { label: "Index list", sql: "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY tbl_name;" },
];

interface QueryRowProps {
    readonly active: boolean;
    readonly onDelete: (id: string) => void;
    readonly onSelect: (id: string) => void;
    readonly query: SavedQuery;
}

/** One saved-query row in the PRIVATE list: select on click, delete on the trailing button. */
const QueryRow = ({ active, onDelete, onSelect, query }: QueryRowProps): ReactElement => {
    const t = useT();
    const onClick = (): void => {
        onSelect(query.id);
    };
    const onDeleteClick = (event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        onDelete(query.id);
    };

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

interface SqlQuerySidebarProps {
    /** The active saved-query id (highlights its row), or null when editing an unlinked draft. */
    readonly activeId: null | string;
    readonly history: ReadonlyArray<HistoryEntry>;
    /** Ref onto the Private list element so the parent can scroll a loaded query into view. */
    readonly listRef: RefObject<HTMLUListElement | null>;
    readonly onClearHistory: () => void;
    readonly onDelete: (id: string) => void;
    /** Load a past run back into the editor; the handler reads `data-sql` off the button. */
    readonly onLoadHistory: (event: MouseEvent<HTMLButtonElement>) => void;
    /** Load a reference template into the editor; the handler reads `data-sql` off the button. */
    readonly onLoadTemplate: (event: MouseEvent<HTMLButtonElement>) => void;
    readonly onNew: () => void;
    readonly onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly onSelect: (id: string) => void;
    readonly queries: ReadonlyArray<SavedQuery>;
    readonly search: string;
}

/** Saved queries whose name contains `search` (case-insensitive); all of them when it is blank. */
const matchingQueries = (queries: ReadonlyArray<SavedQuery>, search: string): SavedQuery[] => {
    const needle = search.trim().toLowerCase();

    return needle === "" ? [...queries] : queries.filter((query) => query.name.toLowerCase().includes(needle));
};

/**
 * The SQL editor's left rail: a search box + new-query button, the browser-persisted
 * PRIVATE saved queries, the canned REFERENCE templates, and the run HISTORY. Pure
 * presentation — the panel owns the query/history state and all the handlers; this
 * just lays them out and filters the Private list by the search box.
 */
const SqlQuerySidebar = ({
    activeId,
    history,
    listRef,
    onClearHistory,
    onDelete,
    onLoadHistory,
    onLoadTemplate,
    onNew,
    onSearchChange,
    onSelect,
    queries,
    search,
}: SqlQuerySidebarProps): ReactElement => {
    const t = useT();
    const filtered = matchingQueries(queries, search);

    return (
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
                    onClick={onNew}
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
                    <p className="px-1 pb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Private")}</p>
                    {filtered.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground" data-testid="sql-private-empty">
                            {t("No saved queries yet — they save to this browser as you type.")}
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-px" data-testid="sql-private" ref={listRef}>
                            {filtered.map((query) => (
                                <QueryRow active={activeId === query.id} key={query.id} onDelete={onDelete} onSelect={onSelect} query={query} />
                            ))}
                        </ul>
                    )}
                </div>

                <div>
                    <p className="px-1 pb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Reference")}</p>
                    <ul className="flex flex-col gap-px">
                        {TEMPLATES.map((template) => (
                            <li key={template.label}>
                                <button
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent"
                                    data-sql={template.sql}
                                    onClick={onLoadTemplate}
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
                            <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("History")}</p>
                            <button
                                className="rounded px-1 text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
                                data-testid="sql-history-clear"
                                onClick={onClearHistory}
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
                                        onClick={onLoadHistory}
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
    );
};

export { SqlQuerySidebar, TEMPLATES };
export type { HistoryEntry, SavedQuery };
