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
 *
 * `covered` is the fourth fact, and the one `done` cannot carry: whether the
 * companion holds a row for EVERY document, regardless of which analyzer built
 * it. A profile change clears `done` and sends the walk back to the top, so from
 * its second page a rebuild's progress row is indistinguishable from a brand-new
 * index's — same cursor, same `done: false`, same profile. The two need opposite
 * answers on the read path (a new index covers a prefix and must refuse; a
 * rebuild covers everything and must serve), so the distinction is recorded
 * rather than inferred. It is sticky: this engine never empties a companion, and
 * once a walk has reached the end of the table the write path keeps every later
 * row in step.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-search-state" mirrors its parent "ctx-db.ts" (the established public module name). */

import type { SearchBackfillState } from "@lunora/search-core";
import { sql as dsql } from "drizzle-orm";

// Type-only import for the structural surface threaded in — a value import
// would create a runtime cycle with `ctx-db.ts` (which imports this module).
import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** Reserved table holding one backfill-progress row per search companion. */
const SEARCH_STATE_TABLE = "__lunora_search_state";

/** Create the progress table. Idempotent; called from `runShardMigrations`. */
const migrateSearchState = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(SEARCH_STATE_TABLE)} (${dsql.identifier("companion")} TEXT PRIMARY KEY, ${dsql.identifier("cursor")} TEXT, ${dsql.identifier("done")} INTEGER NOT NULL DEFAULT 0, ${dsql.identifier("profile")} TEXT, ${dsql.identifier("covered")} INTEGER NOT NULL DEFAULT 0)`,
    );

    // A table created by an earlier build has no `profile` column, and
    // `CREATE TABLE IF NOT EXISTS` will not add one — every read would then
    // fail on the missing column. Mirrors the sql-store twin.
    try {
        runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(SEARCH_STATE_TABLE)} ADD COLUMN ${dsql.identifier("profile")} TEXT`);
    } catch {
        // Already present (or the table was just created with it).
    }

    try {
        runDrizzle(sql, dsql`ALTER TABLE ${dsql.identifier(SEARCH_STATE_TABLE)} ADD COLUMN ${dsql.identifier("covered")} INTEGER NOT NULL DEFAULT 0`);

        // Reached only on the deploy that adds the column, so the rows in front
        // of it predate any `covered` write — and `done` already says it for
        // them: a companion recorded as finished has walked the whole table.
        // Without this an index that was complete before this build, and whose
        // profile changes in this same deploy, would read as uncovered and
        // refuse every search for the length of the rebuild.
        runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SEARCH_STATE_TABLE)} SET ${dsql.identifier("covered")} = 1 WHERE ${dsql.identifier("done")} = 1`);
    } catch {
        // Already present (or the table was just created with it).
    }
};

/** A persisted flag column (`done`, `covered`), however this engine's driver spells a boolean. */
const isTrue = (value: unknown): boolean => value === 1 || value === true || value === "1";

/**
 * Does this companion hold a row for every document in its table?
 *
 * Read separately from {@link readSearchBackfillState} on purpose: the search
 * read path asks it only once the shared plan has already said "not finished",
 * which is the path that would otherwise refuse — so a complete index still
 * costs the one primary-key lookup it did before.
 */
const readSearchIndexCoverage = (sql: SqlExec, companion: string): boolean => {
    const rows = runDrizzle<{ covered: number }>(
        sql,
        dsql`SELECT ${dsql.identifier("covered")} FROM ${dsql.identifier(SEARCH_STATE_TABLE)} WHERE ${dsql.identifier("companion")} = ${companion}`,
    ).toArray();

    return isTrue(rows[0]?.covered);
};

/** Read a companion's progress. An unknown companion has done nothing yet. */
const readSearchBackfillState = (sql: SqlExec, companion: string): SearchBackfillState => {
    const rows = runDrizzle<{ cursor: null | string; done: number; profile: null | string }>(
        sql,
        dsql`SELECT ${dsql.identifier("cursor")}, ${dsql.identifier("done")}, ${dsql.identifier("profile")} FROM ${dsql.identifier(SEARCH_STATE_TABLE)} WHERE ${dsql.identifier("companion")} = ${companion}`,
    ).toArray();

    const row = rows[0];

    if (!row) {
        return { cursor: undefined, done: false, profile: undefined };
    }

    // Same tolerance as the sql-store twin: engines and drivers disagree about
    // whether a boolean column comes back as 1, true or "1", and the two
    // readers decoding the shared state row differently is how they start
    // disagreeing about whether an index is finished.
    return { cursor: row.cursor ?? undefined, done: isTrue(row.done), profile: row.profile ?? undefined };
};

/**
 * Record a page's outcome: how far it got, whether the table is done, and under
 * which analysis.
 *
 * `covered` is not a parameter: it is `done`, latched. A walk that reaches the
 * end of the table has put every row in the companion, and nothing here ever
 * takes rows back out (the analyzer rebuild rewrites them in place), so the flag
 * only ever rises — which is what lets a rebuild that has cleared `done` still
 * be told apart from a first walk.
 */
const writeSearchBackfillState = (sql: SqlExec, companion: string, cursor: string | undefined, done: boolean, profile: string): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
    const cursorValue = cursor ?? null;

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(SEARCH_STATE_TABLE)} (${dsql.identifier("companion")}, ${dsql.identifier("cursor")}, ${dsql.identifier("done")}, ${dsql.identifier("profile")}, ${dsql.identifier("covered")}) VALUES (${companion}, ${cursorValue}, ${done ? 1 : 0}, ${profile}, ${done ? 1 : 0}) ON CONFLICT (${dsql.identifier("companion")}) DO UPDATE SET ${dsql.identifier("cursor")} = excluded.${dsql.identifier("cursor")}, ${dsql.identifier("done")} = excluded.${dsql.identifier("done")}, ${dsql.identifier("profile")} = excluded.${dsql.identifier("profile")}, ${dsql.identifier("covered")} = MAX(${dsql.identifier(SEARCH_STATE_TABLE)}.${dsql.identifier("covered")}, excluded.${dsql.identifier("covered")})`,
    );
};

export { migrateSearchState, readSearchBackfillState, readSearchIndexCoverage, SEARCH_STATE_TABLE, writeSearchBackfillState };
