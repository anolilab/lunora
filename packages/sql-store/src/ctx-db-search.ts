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

import { LunoraError } from "@lunora/errors";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { planSearchBackfillPass, searchTextUnchanged } from "@lunora/search-core";
import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";

import {
    clearSearchBackfillState,
    migrateSearchState,
    readSearchBackfillState,
    readSearchIndexCoverage,
    writeSearchBackfillState,
} from "./ctx-db-search-state";
import type { SqlDialect } from "./dialect";
import type { SearchStage } from "./search-layout";
import { companionFor, companionProfile, globalSearchIndexes, purgeDocument, resolveSearchLayout } from "./search-layout";
import type { SqlCtxExec } from "./sql-exec";
import { forEachRowPaged, queryAll, queryRun } from "./sql-exec";

/**
 * Does this companion hold a row for every document in its table?
 *
 * The finished case first, and on its own: it is every read of a healthy index,
 * and it answers from a single primary-key lookup. Only where the shared plan
 * says the walk is unfinished — the path that is about to refuse or serve a
 * rebuild — is the second lookup paid for.
 */
const searchIndexCoversTable = async (exec: SqlCtxExec, dialect: SqlDialect, tableName: string, index: SearchIndexDefinitionLike): Promise<boolean> => {
    const companion = companionFor(tableName, index);

    if (planSearchBackfillPass(await readSearchBackfillState(exec, dialect, companion), companionProfile(index, dialect)).finished) {
        return true;
    }

    return readSearchIndexCoverage(exec, dialect, companion);
};

/**
 * Run a staged search against whichever layout this index uses — refusing
 * rather than answering from a half-built index.
 *
 * A NEW search index declared over a table that already holds rows covers a
 * growing PREFIX of it (`id ASC`) until its backfill finishes, and every layout
 * queries the companion regardless — so a matching document past the cursor is
 * simply absent from a result set that looks complete. `ensureMigrated` is
 * memoised per ctx-db, so a table advances one page per request: a million-row
 * table would serve partial results, with no error and no signal, for thousands
 * of them.
 *
 * Only that case. An index REBUILDING under a changed profile holds every row
 * throughout — the re-walk rewrites each one in place — and refusing there would
 * take the table's search offline for the whole rebuild, which on an analyzer
 * version bump is every table at once. It serves, some rows still analyzed by
 * the previous rules. {@link searchIndexCoversTable} is where the two are told
 * apart, and it is the same distinction `@lunora/shard-engine` makes.
 */
const runSqlSearch = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    stage: SearchStage,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    if (!(await searchIndexCoversTable(exec, dialect, tableName, stage.definition))) {
        throw new LunoraError(
            "SEARCH_INDEX_BUILDING",
            `search index "${stage.indexName}" on table "${tableName}" is still backfilling and currently covers only part of the table — retry once it finishes, or run the backfillSearch admin operation to complete it now`,
        );
    }

    return resolveSearchLayout(stage.definition, dialect).runSearch(exec, dialect, definition, tableName, stage, limit);
};

/**
 * The layout half of a recorded profile — the suffix `companionProfile` appends.
 *
 * Read off the end rather than parsed: a layout name is one of three fixed
 * words and holds no `/`, while the analysis half in front of it carries a
 * dot-separated field path that one day might.
 */
const layoutOf = (profile: string): string => profile.slice(profile.lastIndexOf("/") + 1);

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
        // A REBUILD: the stored rows were built under a profile the query side
        // no longer uses (a changed `language` or `field`, a new analyzer
        // version), so the walk restarts at the top of the table.
        //
        // It deliberately does NOT empty the companion first. Emptying took a
        // COMPLETE index down to nothing and then refilled it one page per
        // request — on a large table, thousands of requests answered from an
        // index covering a fraction of the rows, with the read path querying it
        // either way; on a `staged` index, which the migration pass never
        // backfills, it never refilled at all. Every layout writes a document
        // DELETE-then-INSERT, so the re-walk converges on the new profile in
        // place while each row keeps serving the old one until its turn: stale
        // analysis on a shrinking suffix, rather than no row at all.
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

        // A companion built for a different LAYOUT has different *columns*, so
        // `CREATE TABLE IF NOT EXISTS` leaves the old shape in place and the
        // index DDL below then references a column that isn't there — a throw
        // that escapes `ensureMigrated` and takes every read and write on this
        // binding down, not just search. That one is unsalvageable: drop it, and
        // forget the progress row with it, so the walk restarts over a companion
        // that really is empty and the read path refuses until it finishes.
        //
        // A change to the analysis or the indexed field is NOT that. Those keep
        // the same columns, so the rows stay readable and the backfill rewrites
        // each one in place (see `backfillSearchIndexPage`). Dropping there
        // emptied a complete index — and on a `staged` index, which the
        // migration pass never backfills, nothing ever refilled it: zero hits on
        // every request from then on.
        //
        // Clearing the row rather than rewriting it also keeps this a one-time
        // event: the guard needs a profile to be recorded, and there no longer
        // is one.
        if (recorded.profile !== undefined && layoutOf(recorded.profile) !== layoutOf(profile)) {
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await queryRun(exec, dialect, sql`DROP TABLE IF EXISTS ${sql.identifier(companion)}`);
            // eslint-disable-next-line no-await-in-loop -- state writes run sequentially on the shared connection.
            await clearSearchBackfillState(exec, dialect, companion);
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
        await resolveSearchLayout(index, dialect).ensureCompanion(exec, dialect, companion);
    }
};

/**
 * Does `tableName` hold at least one row? `false` when the table is not there at
 * all — a host may manage its own DDL, and "no table" is "no rows to walk",
 * which is exactly how the caller below wants it treated.
 */
const tableHasRows = async (exec: SqlCtxExec, dialect: SqlDialect, tableName: string): Promise<boolean> => {
    const present = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (present.length === 0) {
        return false;
    }

    const first = await queryAll(exec, dialect, sql`SELECT 1 FROM ${sql.identifier(tableName)} LIMIT 1`);

    return first.length > 0;
};

/**
 * Provision the search companions, then index one bounded page of the rows that
 * predate each index — unless it is declared `staged: true` over a table that
 * has rows to walk, which leaves the whole backfill to
 * {@link backfillSqlSearchIndexes}.
 *
 * Idempotent (`CREATE … IF NOT EXISTS` throughout, and the backfill resumes
 * from recorded progress).
 */
const runSqlSearchMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    await ensureSearchCompanions(exec, schema, dialect);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        // `staged` keeps the row walk out of the cold start, for tables too large
        // to walk there. A table with no rows is not one of those, and skipping it
        // records NOTHING — so the index reports no coverage and {@link runSqlSearch}
        // refuses every search until an operator runs the backfill by hand, on a
        // table the write path had covered all along. The page below walks nothing
        // and records that completion, which is the whole cost. The shard plane
        // guards this in `ctx-db-backfill.ts`; this one did not.
        // eslint-disable-next-line no-await-in-loop -- one indexed probe per staged index, on the shared connection.
        if (index.staged && (await tableHasRows(exec, dialect, tableName))) {
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
