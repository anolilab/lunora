/**
 * Full-text search for the `.global()` store: provisioning, backfill, and the
 * write-path hook that keeps a companion in step with a row write.
 *
 * How* a companion is stored — FTS5 shadow, portable inverted table, or the
 * engine's own index — lives in `search-layout.ts` behind one interface, so
 * everything here is layout-agnostic: it resolves the layout once and asks it
 * to create, write, or read. That is the seam that used to be a three-way
 * `if/else` repeated at each of those three points.
 *
 * Extracted from `ctx-db.ts` (which was already the largest file in the repo)
 * along the same seam `@lunora/do` uses for its companion/migration/backfill
 * cluster. Everything here reaches the engine through `sql-exec`, never through
 * the store core, so there is no cycle back to `ctx-db.ts`.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-search" mirrors its parent "ctx-db.ts", the established module name in this package. */

import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/do";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { planSearchBackfillPass, searchTextUnchanged } from "@lunora/search-core";
import { sql } from "drizzle-orm";

import { migrateSearchState, readSearchBackfillState, writeSearchBackfillState } from "./ctx-db-search-state";
import type { SqlDialect } from "./dialect";
import type { SearchStage } from "./search-layout";
import { companionFor, companionProfile, globalSearchIndexes, purgeDocument, resolveSearchLayout } from "./search-layout";
import type { SqlCtxExec } from "./sql-exec";
import { forEachRowPaged, queryAll, queryRun } from "./sql-exec";

/** Run a staged search against whichever layout this index uses. */
const runSqlSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    stage: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => resolveSearchLayout(stage.definition, dialect).runSearch(exec, dialect, definition, tableName, stage, limit);

/**
 * Rows indexed per backfill pass. `ensureMigrated` runs once per ctx-db — per
 * request on a Hyperdrive binding — so a pass has to fit comfortably inside a
 * request budget. Indexing a page at a time means a large table becomes
 * searchable progressively rather than blocking the first request after deploy
 * behind a full-table walk.
 */
const SEARCH_BACKFILL_BATCH_ROWS = 200;

/**
 * Index one page of `tableName` into a search companion, resuming from the
 * recorded cursor. Returns `true` when the table is fully indexed.
 *
 * Progress is read from and written to the state table rather than inferred
 * from the companion's contents: a companion that has been live for a while is
 * non-empty because *writes* filled it, so "has rows" would report an
 * un-backfilled index as complete and permanently strand every row that
 * predates the index — exactly the rows the backfill exists to reach.
 */
const backfillSearchIndexPage = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
): Promise<boolean> => {
    const companion = companionFor(tableName, index);
    const layout = resolveSearchLayout(index, dialect);
    const profile = companionProfile(index, dialect);
    const pass = planSearchBackfillPass(await readSearchBackfillState(exec, dialect, companion), profile);

    if (pass.finished) {
        return true;
    }

    if (pass.wipe) {
        // The stored tokens were analyzed by rules the query side no longer
        // uses (a changed `language`, a new analyzer version). Half-matching
        // forever is the worst outcome, so discard and walk the table again.
        await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(companion)}`);
        await writeSearchBackfillState(exec, dialect, companion, undefined, false, profile);
    }

    // The source table may not exist yet — the companion DDL runs for every
    // table the schema declares without a shard mode, and a host that manages
    // its own DDL may not have created this one. Record completion so this stays
    // a one-time probe rather than a per-request one.
    const sourceRows = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (sourceRows.length === 0) {
        await writeSearchBackfillState(exec, dialect, companion, undefined, true, profile);

        return true;
    }

    // Counts rows *walked*, not rows indexed: a page whose rows are missing an
    // id (or fail to decode) would otherwise look short and be mistaken for the
    // end of the table, permanently stranding everything after it.
    let walked = 0;
    let lastId = pass.cursor;

    await forEachRowPaged(
        exec,
        dialect,
        definition,
        tableName,
        async (document) => {
            walked += 1;

            const id = document["_id"];

            if (typeof id !== "string") {
                return;
            }

            lastId = id;

            await layout.indexDocument(exec, dialect, companion, id, document, index);
        },
        { after: pass.cursor, limit: SEARCH_BACKFILL_BATCH_ROWS },
    );

    const done = walked < SEARCH_BACKFILL_BATCH_ROWS;

    await writeSearchBackfillState(exec, dialect, companion, lastId, done, profile);

    return done;
};

/**
 * Materialize the companion tables (and the progress table they report into)
 * for every declared search index. Split out because both entry points below
 * need it: the migration pass, and the out-of-band runner a host may call
 * before any ctx-db has migrated this binding.
 */
const ensureSearchCompanions = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    await migrateSearchState(exec, dialect);

    for (const [tableName, , index] of globalSearchIndexes(schema)) {
        const companion = companionFor(tableName, index);
        const profile = companionProfile(index, dialect);
        // eslint-disable-next-line no-await-in-loop -- one indexed probe per index, on the shared connection.
        const recorded = await readSearchBackfillState(exec, dialect, companion);

        // A companion built for a different layout has different *columns*, so
        // `CREATE TABLE IF NOT EXISTS` leaves the old shape in place and the
        // index DDL below then references a column that isn't there — a throw
        // that escapes `ensureMigrated` and takes every read and write on this
        // binding down, not just search. Drop it and rebuild; the profile
        // mismatch makes the backfill repopulate.
        if (recorded.profile !== undefined && recorded.profile !== profile) {
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await queryRun(exec, dialect, sql`DROP TABLE IF EXISTS ${sql.identifier(companion)}`);

            // Record the rebuild here, not only in the backfill. A `staged`
            // index is skipped by the backfill entirely, so leaving the old
            // profile recorded would re-enter this branch on *every* request:
            // DDL per request under load, every write since the last one
            // destroyed by the next drop, and an index that returns nothing
            // until a host happens to re-run the out-of-band backfill.
            // eslint-disable-next-line no-await-in-loop -- state writes run sequentially on the shared connection.
            await writeSearchBackfillState(exec, dialect, companion, undefined, false, profile);
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
        await resolveSearchLayout(index, dialect).ensureCompanion(exec, dialect, companion);
    }
};

/**
 * Provision the search companions, then index one bounded page of the rows that
 * predate each index — unless it is declared `staged: true`, which leaves the
 * whole backfill to {@link backfillSqlSearchIndexes}.
 *
 * Idempotent (`CREATE … IF NOT EXISTS` throughout, and the backfill resumes
 * from recorded progress).
 */
const runSqlSearchMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    await ensureSearchCompanions(exec, schema, dialect);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        if (index.staged) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- backfill pages run sequentially on the shared connection.
        await backfillSearchIndexPage(exec, dialect, definition, tableName, index);
    }
};

/**
 * Run every declared search index — including the `staged: true` ones the
 * migration pass skips — through to completion. The entry point a host calls
 * out-of-band after deploying a search index over a table too large to index a
 * page at a time.
 *
 * Idempotent and resumable: an index recorded as complete is skipped, and an
 * interrupted run picks up from its cursor.
 */
const backfillSqlSearchIndexes = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    // Self-sufficient: a host may run this before any ctx-db has migrated this
    // binding, and "the documented remedy throws unless you happened to migrate
    // first" is not a remedy.
    await ensureSearchCompanions(exec, schema, dialect);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        let done = false;

        while (!done) {
            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential: each resumes from the prior page's cursor.
            done = await backfillSearchIndexPage(exec, dialect, definition, tableName, index);
        }
    }
};

/**
 * Build the write-path hook that keeps a table's search companions in step with
 * a row write. A no-op when the table declares no search indexes;
 * `document === undefined` (a row removal) deletes only, and a write that left
 * the indexed text alone skips the companion entirely.
 */
const createSearchSync = (deps: {
    dialect: SqlDialect;
    exec: SqlCtxExec;
    schema: SchemaLike;
}): ((tableName: string, id: string, document: Record<string, unknown> | undefined, previous?: Record<string, unknown>) => Promise<void>) => {
    const { dialect, exec, schema } = deps;

    return async (tableName, id, document, previous) => {
        const indexes = schema.tables[tableName]?.searchIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // Fast path: this write didn't touch the indexed text, so the
            // companion rows are already correct — no DELETE, no re-tokenizing,
            // no INSERT round trips (mirrors the rank companion's skip).
            if (searchTextUnchanged(previous, document, index)) {
                continue;
            }

            const companion = companionFor(tableName, index);

            if (document) {
                // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the shared connection so DELETE/INSERT pairs don't interleave across indexes.
                await resolveSearchLayout(index, dialect).indexDocument(exec, dialect, companion, id, document, index);

                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential companion write on the shared connection (see above).
            await purgeDocument(exec, dialect, companion, id);
        }
    };
};

export type { SearchStage } from "./search-layout";
export { backfillSqlSearchIndexes, createSearchSync, runSqlSearch, runSqlSearchMigrations };
