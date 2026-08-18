import type { RefObject } from "react";
import { useRef, useState } from "react";

import { useT } from "../../../i18n/i18n-context";
import type { StorageKind } from "../../../lib/browser-storage";
import { newId, removeJson, saveJson, usePersistedList, usePersistedValue } from "../../../lib/browser-storage";
import type { HistoryEntry, SavedQuery } from "../sql-query-sidebar";

const STORAGE_KEY = "lunora-studio-sql-queries";
const HISTORY_KEY = "lunora-studio-sql-history";

/**
 * Whether the run history outlives the tab. The PREFERENCE is persisted (it is a
 * setting, not data); the history it governs is not, unless it says so.
 */
const REMEMBER_KEY = "lunora-studio-sql-remember-history";

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
    /** True when the history is persisted across sessions rather than kept to this tab. */
    readonly rememberHistory: boolean;
    readonly search: string;
    readonly selectQuery: (id: string) => void;
    /** Flip whether the run history survives closing the tab. */
    readonly setRememberHistory: (remember: boolean) => void;
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
    // Saved queries are deliberate — an operator named and kept them — so they stay
    // in `localStorage`. The run history is not: it is every statement that
    // happened to succeed, literals and all, and before this it outlived the
    // browser on every origin the studio was ever opened from. It now defaults to
    // the tab's lifetime, and only moves to disk if the operator asks it to.
    const [rememberHistory, setRemember] = usePersistedValue<boolean>(REMEMBER_KEY, false);
    const [history, setHistory] = usePersistedList<HistoryEntry>(HISTORY_KEY, rememberHistory ? "local" : "session");
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
        // Both areas, not just the active one: after toggling "remember" off, the
        // on-disk copy is the one the operator wants gone, and it is no longer the
        // area `setHistory` writes to.
        removeJson(HISTORY_KEY, "local");
        removeJson(HISTORY_KEY, "session");
    };

    /**
     * Move the history between the tab and the disk.
     *
     * The list itself moves with it, and turning it OFF deletes the on-disk copy
     * rather than orphaning it — a toggle that leaves the statements it was hiding
     * still sitting in `localStorage` is a setting that lies.
     */
    const setRememberHistory = (remember: boolean): void => {
        const target: StorageKind = remember ? "local" : "session";

        // Seed the destination BEFORE flipping. `usePersistedList` reloads from the
        // new area when the slot changes, so without this, asking to keep the
        // history is what discards it — which is the opposite of what the operator
        // just clicked.
        saveJson(HISTORY_KEY, history, target);

        if (!remember) {
            removeJson(HISTORY_KEY, "local");
        }

        setRemember(remember);
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
        rememberHistory,
        search,
        selectQuery,
        setRememberHistory,
        updateQuerySql,
    };
};

export { useSqlLibrary };
export type { SqlLibrary };
