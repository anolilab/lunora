/**
 * Backfill bookkeeping for the `.global()` store's search companions — the
 * cross-engine twin of `@lunora/do`'s `ctx-db-search-state`.
 *
 * Indexing the rows that predate a search index is paged, so something has to
 * remember how far it got. The companion's own contents cannot answer that: one
 * that has been live for a while is non-empty because writes filled it, and a
 * backfill interrupted halfway leaves rows behind too, so "has rows" would
 * report an un-backfilled index as complete and strand every pre-index row
 * permanently. Progress is therefore recorded explicitly, one row per
 * companion, in a reserved table beside the other `__lunora_*` bookkeeping.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-search-state" mirrors its parent "ctx-db.ts", the established module name in this package. */

import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { queryAll, queryRun } from "./sql-exec";

/** Reserved table holding one backfill-progress row per search companion. */
const SEARCH_STATE_TABLE = "__lunora_search_state";

/** How far a companion's backfill has progressed. */
interface SearchBackfillState {
    /** Last `id` indexed, or `undefined` when no page has run yet. */
    cursor: string | undefined;
    /** True once a page came back short — the table is fully indexed. */
    done: boolean;
}

/** Create the progress table. Idempotent; runs alongside the companion DDL. */
const migrateSearchState = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<void> => {
    const { integer, key } = dialect.companionTypes;

    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("cursor")} ${sql.raw(key)}, ${sql.identifier("done")} ${sql.raw(integer)} NOT NULL DEFAULT 0)`,
    );
};

/** Read a companion's progress. An unknown companion has done nothing yet. */
const readSearchBackfillState = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<SearchBackfillState> => {
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("cursor")}, ${sql.identifier("done")} FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`,
    );

    const row = rows[0];

    if (!row) {
        return { cursor: undefined, done: false };
    }

    const { cursor } = row;

    // `done` arrives as 1/0 on SQLite and MySQL, and as a number or boolean
    // depending on the Postgres driver — normalize rather than trusting one.
    return { cursor: typeof cursor === "string" ? cursor : undefined, done: row["done"] === 1 || row["done"] === true || row["done"] === "1" };
};

/**
 * Record a page's outcome. Written as a delete-then-insert rather than an
 * engine-specific upsert: the three dialects spell `ON CONFLICT` three
 * different ways, and this row is written once per backfill page, never on a
 * hot path.
 */
const writeSearchBackfillState = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    companion: string,
    cursor: string | undefined,
    done: boolean,
): Promise<void> => {
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`);
    await queryRun(
        exec,
        dialect,
        // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
        sql`INSERT INTO ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")}, ${sql.identifier("cursor")}, ${sql.identifier("done")}) VALUES (${companion}, ${cursor ?? null}, ${done ? 1 : 0})`,
    );
};

export type { SearchBackfillState };
export { migrateSearchState, readSearchBackfillState, SEARCH_STATE_TABLE, writeSearchBackfillState };
