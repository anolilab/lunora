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
import { planBackfillPass, searchTextUnchanged } from "@lunora/search-core";
import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike } from "@lunora/shard-engine";
import { ftsRowidMapName } from "@lunora/shard-engine";
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
import { companionFor, companionProfile, globalSearchIndexes, resolveSearchLayout } from "./search-layout";
import type { MigrationMode, MigrationReport } from "./search-layout-migrations";
import { ROW_VERSION_COLUMNS } from "./search-writes";
import type { SqlCtxExec } from "./sql-exec";
import { decodeRow, forEachRowPaged, queryAll, queryRun, readRowsPage } from "./sql-exec";

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

    if (planBackfillPass(await readSearchBackfillState(exec, dialect, companion), companionProfile(index, dialect)).finished) {
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
            `search index "${stage.indexName}" on table "${tableName}" is still backfilling and currently covers only part of the table — retry once it finishes${dialect.searchBackfillHint === undefined ? "" : `, or complete it now: ${dialect.searchBackfillHint}`}`,
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
 * Write-then-recheck rounds per backfill page. Each extra round happens only for
 * rows written concurrently with the page, so the second is already rare.
 *
 * ponytail: a row rewritten on every round past this is left to its writers — it
 * stays unindexed only if every one of those writes left the indexed text alone.
 */
const SEARCH_BACKFILL_ATTEMPTS = 5;

/**
 * A source row as a writer last saw it — at least `id` and the
 * {@link ROW_VERSION_COLUMNS} — and the document it holds, when the writer
 * already has it decoded.
 */
interface PendingRow {
    document?: Record<string, unknown>;
    row: Record<string, unknown>;
}

/**
 * Re-read the `pending` rows and return the ones written since they were read,
 * in their current state. A row absent from the re-read was deleted, and the
 * delete purged its entry. Versions are compared as strings: drivers disagree
 * on number types.
 */
const rowsMovedSince = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    tableName: string,
    pending: ReadonlyMap<string, PendingRow>,
): Promise<Map<string, PendingRow>> => {
    const ids = [...pending.keys()];
    const current = await queryAll(
        exec,
        dialect,
        sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} >= ${ids[0]} AND ${sql.identifier("id")} <= ${ids.at(-1)} ORDER BY ${sql.identifier("id")} ASC`,
    );
    const moved = new Map<string, PendingRow>();

    for (const row of current) {
        const id = row["id"] as string;
        const read = pending.get(id)?.row;

        if (read && ROW_VERSION_COLUMNS.some((column) => String(read[column]) !== String(row[column]))) {
            moved.set(id, { row });
        }
    }

    return moved;
};

/**
 * Index rows into a companion, safely against writers in other isolates — the
 * backfill's page, and each live write.
 *
 * Between reading or writing a source row and writing its entry, another
 * isolate may write the same row; the per-isolate single-flight memo does not
 * reach across isolates. So each entry write carries the row as last seen, and
 * on the FTS5 and inverted layouts it lands only if that row is still current,
 * checked inside the write itself — a stale entry never replaces a fresher one.
 *
 * A write that did not land was left to the concurrent writer, but that writer
 * re-indexes only if it changed the indexed text. So the rows are re-read
 * afterwards, and every row whose version moved is indexed again from its new
 * state, until none did. On the native layout, whose writes are unguarded, the
 * re-check alone makes the result correct.
 */
const indexRowsUntilCurrent = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    companion: string,
    index: SearchIndexDefinitionLike,
    rows: ReadonlyMap<string, PendingRow>,
): Promise<void> => {
    const layout = resolveSearchLayout(index, dialect);
    let pending = rows;

    for (let attempt = 0; pending.size > 0 && attempt < SEARCH_BACKFILL_ATTEMPTS; attempt += 1) {
        for (const { document, row } of pending.values()) {
            const current = document ?? decodeRow(definition, row);

            if (current) {
                // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the shared connection.
                await layout.indexDocument(exec, dialect, companion, current, index, { row, table: tableName });
            }
        }

        // eslint-disable-next-line no-await-in-loop -- the re-check has to follow the writes it checks.
        pending = await rowsMovedSince(exec, dialect, tableName, pending);
    }

    if (pending.size > 0) {
        // eslint-disable-next-line no-console -- the only channel a background write has
        console.warn(
            `[@lunora/sql-store] search index "${companion}": ${String(pending.size)} row(s) were rewritten on every one of ${String(SEARCH_BACKFILL_ATTEMPTS)} re-check rounds and were left to their writers — each stays stale only if none of those writes changed its indexed text.`,
        );
    }
};

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
    const profile = companionProfile(index, dialect);
    const pass = planBackfillPass(await readSearchBackfillState(exec, dialect, companion), profile);

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
        // backfills, it never refilled at all. Every layout replaces a
        // document's rows in place, so the re-walk converges on the new profile
        // while each row keeps serving the old one until its turn: stale
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

    const pageRows = await readRowsPage(exec, dialect, tableName, pass.cursor, SEARCH_BACKFILL_BATCH_ROWS);
    const lastId = pageRows.findLast((row) => typeof row["id"] === "string")?.["id"] as string | undefined;

    const pending = new Map<string, PendingRow>();

    for (const row of pageRows) {
        if (typeof row["id"] === "string") {
            pending.set(row["id"], { row });
        }
    }

    await indexRowsUntilCurrent(exec, dialect, definition, tableName, companion, index, pending);

    // Rows walked, not rows indexed: a page with undecodable rows is not short.
    const done = pageRows.length < SEARCH_BACKFILL_BATCH_ROWS;

    // A page whose ids are all unusable keeps the resume point, rather than
    // sending the next pass back to the top of the table.
    await writeSearchBackfillState(exec, dialect, companion, lastId ?? pass.cursor, done, profile);

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
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
            await queryRun(exec, dialect, sql`DROP TABLE IF EXISTS ${sql.identifier(ftsRowidMapName(companion))}`);
            // eslint-disable-next-line no-await-in-loop -- state writes run sequentially on the shared connection.
            await clearSearchBackfillState(exec, dialect, companion);
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
        await resolveSearchLayout(index, dialect).ensureCompanion(exec, dialect, companion);
    }
};

/**
 * Record the starting point of a `staged: true` index the first time it is seen.
 *
 * `staged` defers the backfill of rows that PREDATE the index — and a table
 * holding none has nothing to defer. But with no progress row written at all,
 * `planBackfillPass` says "not finished" and `readSearchIndexCoverage` says
 * "not covered", so {@link runSqlSearch} refuses every query on the index with
 * `SEARCH_INDEX_BUILDING`. Nothing lifts it: the migration pass never backfills a
 * staged index, so declaring one alongside a new table took search on that table
 * permanently offline, including for the rows `createSearchSync` indexed on every
 * write after the deploy.
 *
 * So: an empty table is recorded as covered (`done`, which latches `covered`),
 * and a non-empty one is recorded as at-the-top (`done: false`) and left to
 * {@link backfillSqlSearchIndexes} as documented. Writing the profile either way
 * is what makes this a one-time probe — the next migration sees a recorded row
 * and returns on the read above.
 */
const recordStagedIndexBaseline = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
): Promise<void> => {
    const companion = companionFor(tableName, index);
    const recorded = await readSearchBackfillState(exec, dialect, companion);

    if (recorded.profile !== undefined) {
        return;
    }

    let rows = 0;
    const sourceRows = await queryAll(exec, dialect, dialect.tableExists(tableName));

    if (sourceRows.length > 0) {
        await forEachRowPaged(
            exec,
            dialect,
            definition,
            tableName,
            () => {
                rows += 1;
            },
            { limit: 1 },
        );
    }

    await writeSearchBackfillState(exec, dialect, companion, undefined, rows === 0, companionProfile(index, dialect));
};

/** What {@link backfillSqlSearchIndexes} could not finish. */
interface SqlSearchBackfillResult {
    /**
     * Inverted companions that still lack their unique `(token, id)` key. Writes
     * keep working without it, but two backfills racing over one row can index
     * it twice; the warning logged for each says why the key was refused.
     */
    uniqueKeyMissing: string[];

    /** A previous build's rows left unmigrated because every attempt at them lost to a concurrent write. */
    unmappedSkipped: number;
}

/** Run a layout's migration of an index's companion, if its layout has one. */
const migrateCompanion = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    index: SearchIndexDefinitionLike,
    mode: MigrationMode,
): Promise<MigrationReport> => {
    const report = await resolveSearchLayout(index, dialect).migrate?.(
        exec,
        dialect,
        { companion: companionFor(tableName, index), definition, index, tableName },
        mode,
    );

    return report ?? { uniqueKeyMissing: false, unmappedSkipped: 0 };
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
        // The layout's bounded per-cold-start share of migrating an older companion.
        // eslint-disable-next-line no-await-in-loop -- sequential on the shared connection.
        await migrateCompanion(exec, dialect, definition, tableName, index, "step");

        if (index.staged) {
            // eslint-disable-next-line no-await-in-loop -- one indexed probe per staged index, on the shared connection.
            await recordStagedIndexBaseline(exec, dialect, definition, tableName, index);

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
const backfillSqlSearchIndexes = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<SqlSearchBackfillResult> => {
    const result: SqlSearchBackfillResult = { uniqueKeyMissing: [], unmappedSkipped: 0 };

    // Self-sufficient: a host may run this before any ctx-db has migrated this
    // binding, and "the documented remedy throws unless you happened to migrate
    // first" is not a remedy.
    await ensureSearchCompanions(exec, schema, dialect);

    for (const [tableName, definition, index] of globalSearchIndexes(schema)) {
        // eslint-disable-next-line no-await-in-loop -- one companion at a time on the shared connection.
        const report = await migrateCompanion(exec, dialect, definition, tableName, index, "drain");

        result.unmappedSkipped += report.unmappedSkipped;

        if (report.uniqueKeyMissing) {
            result.uniqueKeyMissing.push(companionFor(tableName, index));
        }

        let done = false;

        while (!done) {
            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential: each resumes from the prior page's cursor.
            done = await backfillSearchIndexPage(exec, dialect, definition, tableName, index);
        }
    }

    return result;
};

/** A row write, as the search hook sees it: the document now, before, and the version columns the write left. */
interface SearchWrite {
    document: Record<string, unknown>;
    previous?: Record<string, unknown>;
    /** The row's {@link ROW_VERSION_COLUMNS} as this write left them. */
    written: Record<string, unknown>;
}

/**
 * Build the write-path hook that keeps a table's search companions in step with
 * a row write. A no-op when the table declares no search indexes; a `change`
 * of `undefined` (a row removal) deletes only, and a write that left the
 * indexed text alone skips the companion entirely.
 *
 * The entry write is guarded by the version this write left on the row, and
 * re-checked afterwards ({@link indexRowsUntilCurrent}): two writes of one row
 * from different isolates can reach the companion in either order, and the
 * older one must neither land last nor, when it loses, leave the row stale
 * because the newer write left the indexed text alone and skipped it.
 */
const createSearchSync = (deps: {
    dialect: SqlDialect;
    exec: SqlCtxExec;
    schema: SchemaLike;
}): ((tableName: string, id: string, change: SearchWrite | undefined) => Promise<void>) => {
    const { dialect, exec, schema } = deps;

    return async (tableName, id, change) => {
        const definition = schema.tables[tableName];
        const indexes = definition?.searchIndexes;

        if (!definition || !indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // Fast path: this write didn't touch the indexed text, so the
            // companion rows are already correct — no DELETE, no re-tokenizing,
            // no INSERT round trips (mirrors the rank companion's skip).
            if (searchTextUnchanged(change?.previous, change?.document, index)) {
                continue;
            }

            const companion = companionFor(tableName, index);

            if (change) {
                // eslint-disable-next-line no-await-in-loop -- companion writes run sequentially on the shared connection so DELETE/INSERT pairs don't interleave across indexes.
                await indexRowsUntilCurrent(
                    exec,
                    dialect,
                    definition,
                    tableName,
                    companion,
                    index,
                    new Map([[id, { document: change.document, row: { ...change.written, id } }]]),
                );

                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential companion write on the shared connection (see above).
            await resolveSearchLayout(index, dialect).purgeDocument(exec, dialect, companion, id, tableName);
        }
    };
};

export type { SearchStage } from "./search-layout";
export type { SqlSearchBackfillResult };
export { backfillSqlSearchIndexes, createSearchSync, runSqlSearch, runSqlSearchMigrations };
