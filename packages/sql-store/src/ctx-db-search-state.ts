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

import type { SearchBackfillState } from "@lunora/search-core";
import { sql } from "drizzle-orm";

import type { SqlDialect } from "./dialect";
import type { SqlCtxExec } from "./sql-exec";
import { queryAll, queryRun } from "./sql-exec";

/** Reserved table holding one backfill-progress row per search companion. */
const SEARCH_STATE_TABLE = "__lunora_search_state";

/** Create the progress table. Idempotent; runs alongside the companion DDL. */
const migrateSearchState = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<void> => {
    const { integer, key } = dialect.companionTypes;

    // A state table created by an earlier build has no `profile` column, and
    // `CREATE TABLE IF NOT EXISTS` will not add one — so every read of it would
    // fail on the missing column. Add it separately; the failure when it is
    // already there is the expected case, not an error.
    const addProfileColumn = async (): Promise<void> => {
        try {
            await queryRun(exec, dialect, sql`ALTER TABLE ${sql.identifier(SEARCH_STATE_TABLE)} ADD COLUMN ${sql.identifier("profile")} ${sql.raw(key)}`);
        } catch {
            // Column already present (or the table was just created with it).
        }
    };

    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("cursor")} ${sql.raw(key)}, ${sql.identifier("done")} ${sql.raw(integer)} NOT NULL DEFAULT 0, ${sql.identifier("profile")} ${sql.raw(key)})`,
    );

    await addProfileColumn();
};

/** The persisted `done` flag, however this engine's driver spells a boolean. */
const isDone = (value: unknown): boolean => value === 1 || value === true || value === "1";

/** Read a companion's progress. An unknown companion has done nothing yet. */
const readSearchBackfillState = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<SearchBackfillState> => {
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("cursor")}, ${sql.identifier("done")}, ${sql.identifier("profile")} FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`,
    );

    const row = rows[0];

    if (!row) {
        return { cursor: undefined, done: false, profile: undefined };
    }

    const { cursor, profile } = row;

    return {
        cursor: typeof cursor === "string" ? cursor : undefined,
        done: isDone(row["done"]),
        profile: typeof profile === "string" ? profile : undefined,
    };
};

/**
 * Record a page's outcome.
 *
 * UPDATE-then-INSERT rather than DELETE-then-INSERT, because two cold starts
 * can migrate the same binding concurrently. The delete-first shape left a
 * window where the row did not exist — one pass would read "nothing recorded"
 * and restart the walk — and, worse, both passes could reach the INSERT and one
 * would raise a primary-key violation that escapes `ensureMigrated` and takes
 * every read and write on the binding down, not just search.
 *
 * The row never vanishes here, and the loser of an INSERT race falls back to
 * the UPDATE it should have done. Spelled with the portable three statements
 * rather than an upsert because the three dialects spell `ON CONFLICT` three
 * different ways, and this runs once per backfill page, never on a hot path.
 */
const writeSearchBackfillState = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    companion: string,
    cursor: string | undefined,
    done: boolean,
    profile: string,
): Promise<void> => {
    // eslint-disable-next-line unicorn/no-null -- SQL bind value: "no page has run yet" is a NULL column, not undefined
    const cursorValue = cursor ?? null;
    const update = sql`UPDATE ${sql.identifier(SEARCH_STATE_TABLE)} SET ${sql.identifier("cursor")} = ${cursorValue}, ${sql.identifier("done")} = ${done ? 1 : 0}, ${sql.identifier("profile")} = ${profile} WHERE ${sql.identifier("companion")} = ${companion}`;
    const existing = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("companion")} FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`,
    );

    if (existing.length > 0) {
        await queryRun(exec, dialect, update);

        return;
    }

    try {
        await queryRun(
            exec,
            dialect,
            sql`INSERT INTO ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")}, ${sql.identifier("cursor")}, ${sql.identifier("done")}, ${sql.identifier("profile")}) VALUES (${companion}, ${cursorValue}, ${done ? 1 : 0}, ${profile})`,
        );
    } catch (error) {
        // A concurrent pass inserted the row between the probe and here. That
        // is the race this exists for, not a failure — write what we meant to.
        if (!dialect.isUniqueViolation(error)) {
            throw error;
        }

        await queryRun(exec, dialect, update);
    }
};

export { migrateSearchState, readSearchBackfillState, SEARCH_STATE_TABLE, writeSearchBackfillState };
