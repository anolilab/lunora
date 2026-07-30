import type { RefObject } from "react";
import { useRef, useState } from "react";

import { useT } from "../../../i18n/i18n-context";
import { newId, usePersistedList } from "../../../lib/browser-storage";
import type { HistoryEntry, SavedQuery } from "../sql-query-sidebar";

const STORAGE_KEY = "lunora-studio-sql-queries";
const HISTORY_KEY = "lunora-studio-sql-history";

/** How many recent distinct queries the history keeps. */
const HISTORY_LIMIT = 25;

/** Everything {@link useSqlLibrary} hands back — the sidebar's model plus the editor's write path into a saved query. */
interface SqlLibrary {
    readonly clearHistory: () => void;
    readonly deleteQuery: (id: string) => void;
    readonly history: ReadonlyArray<HistoryEntry>;
    /** The Private list, so selecting a query can scroll it into view. */
    readonly listRef: RefObject<HTMLUListElement | null>;
    readonly loadFromHistory: (event: React.MouseEvent<HTMLButtonElement>) => void;
    readonly loadTemplate: (event: React.MouseEvent<HTMLButtonElement>) => void;
    readonly newQuery: () => void;
    readonly onSearchChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly queries: ReadonlyArray<SavedQuery>;
    /** Record a successful run at the head of the history. */
    readonly recordHistory: (sql: string) => void;
    readonly search: string;
    readonly selectQuery: (id: string) => void;
    /** Write a saved query's SQL — the editor's auto-save path for the linked query. */
    readonly updateQuerySql: (id: string, sql: string) => void;
}

/**
 * The SQL editor's query library: the browser-persisted PRIVATE list, the run
 * history, and the sidebar's search box.
 *
 * One hook because it is one store — saved queries and history are both
 * `usePersistedList`s that only the sidebar reads, and neither touches the tabs,
 * the schema, or the run path. It reaches the editor through the two callbacks it
 * is given, so it never needs the tab model itself.
 */
const useSqlLibrary = ({
    loadIntoActiveTab,
    unlinkQuery,
}: {
    /** Load `sql` into the active tab, linked to `savedId` (or unlinked with `null`). */
    readonly loadIntoActiveTab: (sql: string, savedId: null | string) => void;
    /** Unlink every tab mirroring a query that has just been deleted. */
    readonly unlinkQuery: (id: string) => void;
}): SqlLibrary => {
    const t = useT();

    const [queries, setQueries] = usePersistedList<SavedQuery>(STORAGE_KEY);
    const [history, setHistory] = usePersistedList<HistoryEntry>(HISTORY_KEY);
    const [search, setSearch] = useState<string>("");

    const listRef = useRef<HTMLUListElement | null>(null);

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
            listRef.current?.querySelector(`[data-testid="sql-query-${id}"]`)?.scrollIntoView({ block: "nearest" });
        }
    };

    const deleteQuery = (id: string): void => {
        setQueries((current) => current.filter((query) => query.id !== id));
        // Unlink any tab that was editing the deleted query.
        unlinkQuery(id);
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

    const onSearchChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    const updateQuerySql = (id: string, sql: string): void => {
        setQueries((current) => current.map((query) => (query.id === id ? { ...query, sql } : query)));
    };

    return {
        clearHistory,
        deleteQuery,
        history,
        listRef,
        loadFromHistory,
        loadTemplate,
        newQuery,
        onSearchChange,
        queries,
        recordHistory,
        search,
        selectQuery,
        updateQuerySql,
    };
};

export { useSqlLibrary };
export type { SqlLibrary };
