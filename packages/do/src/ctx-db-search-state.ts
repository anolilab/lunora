/**
 * Backfill bookkeeping for the DO store's search companions.
 *
 * A search index that is declared over a table which already holds rows has to
 * index those rows once. That work is paged (see `ctx-db-backfill`), so
 * something has to remember how far it got — and "does the companion have any
 * rows?" cannot answer it: a companion that has been live for a while is
 * non-empty because *writes* filled it, not because the backfill ran, and a
 * backfill killed halfway leaves rows behind too. Inferring completion from the
 * data would silently strand exactly the rows the backfill exists to reach.
 *
 * So progress is recorded explicitly, one row per companion, in a reserved
 * table alongside the other `__lunora_*` bookkeeping. The cursor is the last
 * `id` indexed; `done` flips when a page comes back short.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-search-state" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

// Type-only import for the structural surface threaded in — a value import
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** Reserved table holding one backfill-progress row per search companion. */
const SEARCH_STATE_TABLE = "__lunora_search_state";

/** How far a companion's backfill has progressed. */
interface SearchBackfillState {
    /** Last `id` indexed, or `undefined` when no page has run yet. */
    cursor: string | undefined;
    /** True once a page came back short — the table is fully indexed. */
    done: boolean;
}

/** Create the progress table. Idempotent; called from `runShardMigrations`. */
const migrateSearchState = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(SEARCH_STATE_TABLE)} (${dsql.identifier("companion")} TEXT PRIMARY KEY, ${dsql.identifier("cursor")} TEXT, ${dsql.identifier("done")} INTEGER NOT NULL DEFAULT 0)`,
    );
};

/** Read a companion's progress. An unknown companion has done nothing yet. */
const readSearchBackfillState = (sql: SqlExec, companion: string): SearchBackfillState => {
    const rows = runDrizzle<{ cursor: null | string; done: number }>(
        sql,
        dsql`SELECT ${dsql.identifier("cursor")}, ${dsql.identifier("done")} FROM ${dsql.identifier(SEARCH_STATE_TABLE)} WHERE ${dsql.identifier("companion")} = ${companion}`,
    ).toArray();

    const row = rows[0];

    if (!row) {
        return { cursor: undefined, done: false };
    }

    return { cursor: row.cursor ?? undefined, done: row.done === 1 };
};

/**
 * Record a page's outcome. `cursor` is left where it was when the page indexed
 * nothing (an empty tail), so a resumed run doesn't rewind. Written as an
 * upsert so concurrent cold starts converge on the furthest progress rather
 * than one clobbering the other with a stale cursor.
 */
const writeSearchBackfillState = (sql: SqlExec, companion: string, cursor: string | undefined, done: boolean): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
    const cursorValue = cursor ?? null;

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(SEARCH_STATE_TABLE)} (${dsql.identifier("companion")}, ${dsql.identifier("cursor")}, ${dsql.identifier("done")}) VALUES (${companion}, ${cursorValue}, ${done ? 1 : 0}) ON CONFLICT (${dsql.identifier("companion")}) DO UPDATE SET ${dsql.identifier("cursor")} = MAX(COALESCE(excluded.${dsql.identifier("cursor")}, ''), COALESCE(${dsql.identifier(SEARCH_STATE_TABLE)}.${dsql.identifier("cursor")}, '')), ${dsql.identifier("done")} = MAX(excluded.${dsql.identifier("done")}, ${dsql.identifier(SEARCH_STATE_TABLE)}.${dsql.identifier("done")})`,
    );
};

export type { SearchBackfillState };
export { migrateSearchState, readSearchBackfillState, SEARCH_STATE_TABLE, writeSearchBackfillState };
