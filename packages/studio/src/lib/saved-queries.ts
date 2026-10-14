import type { FilterClause } from "./admin";
import { loadJsonArray, saveJson } from "./browser-storage";

/**
 * A shareable data-browser view: the table, storage tier, shard, structured
 * filters, substring search, and sort that together reproduce exactly what the
 * grid is showing. This is the unit that is serialized into the URL (so the link
 * IS the query) and persisted by name in {@link loadSavedQueries}. Every field is
 * optional so a partial/legacy URL still hydrates into a sensible default view.
 */
interface DataView {
    /** Structured `column operator value` clauses, AND-combined with the search. */
    filters?: FilterClause[];
    /** Single-column sort, server-side; absent → the table's natural order. */
    orderBy?: { column: string; direction: "asc" | "desc" };
    /** Substring search across all columns. */
    search?: string;
    /** Shard key the view targets; absent/empty → the root shard. */
    shard?: string;
    /** The open table. */
    table?: string;
    /** Storage tier the table lives in; absent → the shard (SQLite) tier. */
    tier?: "global" | "shard";
}

/** A user-named, persisted {@link DataView} — the "canned query" the saved-queries panel lists. */
interface SavedQuery {
    name: string;
    view: DataView;
}

/**
 * Named data-browser views, persisted in `localStorage` so they survive a
 * restart (unlike `shard-history.ts`'s `sessionStorage` MRU). The studio can't
 * enumerate views server-side, so it remembers the ones the operator explicitly
 * saved. The guarded load/persist path is shared via {@link ./browser-storage} so a
 * missing/throwing storage (SSR, privacy mode) degrades to "no saved queries".
 */
const STORAGE_KEY = "lunora-studio-saved-queries";

/** Cap the list so it stays a short, useful menu rather than an unbounded log. */
const MAX_SAVED = 50;

/** Narrow an unknown parsed entry to a {@link SavedQuery}, dropping anything malformed. */
const isSavedQuery = (entry: unknown): entry is SavedQuery =>
    entry !== null &&
    typeof entry === "object" &&
    typeof (entry as { name?: unknown }).name === "string" &&
    typeof (entry as { view?: unknown }).view === "object" &&
    (entry as { view: unknown }).view !== null;

/** Saved queries, most-recently-saved first. Empty when storage is unavailable or empty. */
const loadSavedQueries = (): SavedQuery[] => loadJsonArray<unknown>(STORAGE_KEY).filter(isSavedQuery);

const persist = (queries: SavedQuery[]): void => {
    saveJson(STORAGE_KEY, queries);
};

/**
 * Save `view` under `name` (moved to the front, de-duplicated by name, capped).
 * An empty/whitespace name is ignored — there's nothing to recall it by. Saving
 * an existing name overwrites that entry with the new view. Returns the updated
 * list so a caller can update state without re-reading.
 */
const saveQuery = (name: string, view: DataView): SavedQuery[] => {
    const trimmed = name.trim();

    if (trimmed === "") {
        return loadSavedQueries();
    }

    const next = [{ name: trimmed, view }, ...loadSavedQueries().filter((entry) => entry.name !== trimmed)].slice(0, MAX_SAVED);

    persist(next);

    return next;
};

/** Remove the saved query named `name`. Returns the updated list. */
const deleteSavedQuery = (name: string): SavedQuery[] => {
    const next = loadSavedQueries().filter((entry) => entry.name !== name);

    persist(next);

    return next;
};

export type { DataView, SavedQuery };
export { deleteSavedQuery, loadSavedQueries, saveQuery };
