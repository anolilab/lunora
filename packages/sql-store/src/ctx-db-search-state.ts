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
 *
 * The table is a plain `key → {cursor, done, profile}` map and is shared with the
 * one other paged migration that needs the same bookkeeping — `ctx-db.ts`'s
 * bigint re-encoding pass, under a `bigint-rewrite:<table>` key. Its name is
 * historical; renaming it would be a migration of its own for no behavioural gain.
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

    // A state table created by an earlier build has none of the columns added
    // after it, and `CREATE TABLE IF NOT EXISTS` will not add them — so every
    // read of it would fail on the missing column. Add them separately; the
    // failure when one is already there is the expected case, not an error.
    const addColumn = async (column: string, type: string): Promise<void> => {
        try {
            await queryRun(exec, dialect, sql`ALTER TABLE ${sql.identifier(SEARCH_STATE_TABLE)} ADD COLUMN ${sql.identifier(column)} ${sql.raw(type)}`);
        } catch {
            // Column already present (or the table was just created with it).
        }
    };

    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("cursor")} ${sql.raw(key)}, ${sql.identifier("done")} ${sql.raw(integer)} NOT NULL DEFAULT 0, ${sql.identifier("profile")} ${sql.raw(key)}, ${sql.identifier("covered")} ${sql.raw(integer)} NOT NULL DEFAULT 0)`,
    );

    await addColumn("profile", key);
    await addColumn("covered", `${integer} NOT NULL DEFAULT 0`);

    // Catch `covered` up for rows that predate the column, in its OWN statement
    // rather than inside the `ALTER` above: sharing the ALTER's `try` would run
    // this only on the single call that added the column, so a process that
    // stopped between the two left every completed index reading as uncovered
    // for good — refusing every search for the length of its next rebuild.
    //
    // `done` already carries the answer for those rows: a companion recorded as
    // finished has walked the whole table. `AND covered = 0` makes this a no-op
    // write after the first successful pass, so paying for it on every migration
    // costs a matchless scan of a table with one row per index.
    await queryRun(
        exec,
        dialect,
        sql`UPDATE ${sql.identifier(SEARCH_STATE_TABLE)} SET ${sql.identifier("covered")} = 1 WHERE ${sql.identifier("done")} = 1 AND ${sql.identifier("covered")} = 0`,
    );
};

/** A persisted flag column (`done`, `covered`), however this engine's driver spells a boolean. */
const isDone = (value: unknown): boolean => value === 1 || value === true || value === "1";

/**
 * Does this companion hold a row for every document in its table?
 *
 * The fact `done` cannot carry. A profile change clears `done` and sends the
 * walk back to the top, so from its second page a REBUILD's progress row is
 * indistinguishable from a brand-new index's — same cursor, same `done: false`,
 * same profile. The two need opposite answers on the read path (a new index
 * covers a growing prefix and must refuse; a rebuild holds every row under stale
 * analysis and must serve), so the distinction is recorded rather than inferred.
 *
 * Read separately from {@link readSearchBackfillState} on purpose: the read path
 * asks only once the shared plan has said "not finished", which is the path that
 * would otherwise refuse — so a complete index still costs the one primary-key
 * lookup it did before.
 */
const readSearchIndexCoverage = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<boolean> => {
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("covered")} FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`,
    );

    return isDone(rows[0]?.["covered"]);
};

/**
 * Forget everything recorded for a companion, because its rows are gone.
 *
 * The one place coverage falls back to zero: a layout change drops the
 * companion table outright, so the next walk really does start from an empty
 * index. Deleting the row rather than rewriting it also keeps the drop a
 * one-time event — the caller only drops when a profile *is* recorded, and an
 * absent row records nothing.
 */
const clearSearchBackfillState = async (exec: SqlCtxExec, dialect: SqlDialect, companion: string): Promise<void> => {
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(SEARCH_STATE_TABLE)} WHERE ${sql.identifier("companion")} = ${companion}`);
};

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
 *
 * `covered` is not a parameter: it is `done`, latched. A walk that reached the
 * end of the table put every row in the companion, and nothing takes rows back
 * out (a rebuild rewrites each one in place), so the flag only ever rises —
 * which is what lets a rebuild that has cleared `done` still be told apart from
 * a first walk. `covered = covered` is the portable no-op assignment; the three
 * dialects disagree about whether `MAX` is scalar or aggregate.
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
    const coveredSet = done ? sql`${sql.identifier("covered")} = 1` : sql`${sql.identifier("covered")} = ${sql.identifier("covered")}`;
    const update = sql`UPDATE ${sql.identifier(SEARCH_STATE_TABLE)} SET ${sql.identifier("cursor")} = ${cursorValue}, ${sql.identifier("done")} = ${done ? 1 : 0}, ${sql.identifier("profile")} = ${profile}, ${coveredSet} WHERE ${sql.identifier("companion")} = ${companion}`;
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
            sql`INSERT INTO ${sql.identifier(SEARCH_STATE_TABLE)} (${sql.identifier("companion")}, ${sql.identifier("cursor")}, ${sql.identifier("done")}, ${sql.identifier("profile")}, ${sql.identifier("covered")}) VALUES (${companion}, ${cursorValue}, ${done ? 1 : 0}, ${profile}, ${done ? 1 : 0})`,
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

export { clearSearchBackfillState, migrateSearchState, readSearchBackfillState, readSearchIndexCoverage, SEARCH_STATE_TABLE, writeSearchBackfillState };
