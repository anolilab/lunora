/**
 * The FTS5 search companion's statements, shared by the Durable Object store and
 * the `.global()` SQL store (`@lunora/sql-store`) so the two cannot drift.
 *
 * An FTS5 virtual table holds no UNIQUE constraint and no ordinary index, so its
 * `__id__` column is `UNINDEXED` and "the row for document X" cannot be found
 * without a full scan of the companion. That one fact made every write purge by
 * scanning the whole table, and left nothing to stop two writers indexing the
 * same document twice.
 *
 * The fix is an ordinary table beside it — `<companion>__ids` — mapping each
 * document id (UNIQUE) to the FTS5 rowid its entry lives at, so a write finds
 * the entry it replaces with two primary-key lookups.
 *
 * The rowid space is split. The current build writes every entry at a fresh
 * NEGATIVE rowid, below everything the map holds. Everything else — rows a
 * previous build wrote, and rows an isolate still running it writes during a
 * rollout — sits at a POSITIVE rowid, because FTS5 assigns `max(rowid) + 1` and
 * a text-less sentinel row at rowid 0 keeps that maximum from ever going
 * negative. So:
 *
 * - a fresh rowid can never collide with a row the map does not know about;
 * - "rows the map does not know about" is the range `rowid > 0`, which FTS5
 * answers as a rowid range: empty, and so free, once it has drained;
 * - a write also purges its document's positive rows by `__id__`, which keeps
 * the previous build's own repair-on-write while any such rows exist;
 * - `ftsUnmappedPage` feeds a bounded per-cold-start drain that rewrites those
 * rows from the source table, so no marker records "migrated": the data does.
 *
 * External-content FTS5 (`content=<table>`) was the alternative, and it does not
 * fit: it reads the indexed text back from a source column, and our indexed text
 * is derived (a dotted field path, analyzed) — no column holds it. Its rowid
 * would also be the source table's implicit rowid, which `VACUUM` may renumber
 * on a table keyed by a TEXT primary key.
 *
 * Every write and purge is a short list of statements that must run in order,
 * and on D1 as one atomic batch: between them, the entry and the map disagree.
 */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { FTS_ID_COLUMN, FTS_TEXT_COLUMN } from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { sqliteInList } from "./drizzle";

/** Rowids bound one per parameter before the list goes as one JSON array; leaves room for the statement's other parameters. */
const IN_LIST_BUDGET = 50;

/** The mapped FTS5 rowid column in {@link ftsRowidMapName}. */
const FTS_ROWID_COLUMN = "__rowid__";

/** The ordinary table mapping a document id to its FTS5 rowid. */
const ftsRowidMapName = (companion: string): string => `${companion}__ids`;

/** `<table>.<column>`, qualified so an unknown name is an error on engines built with double-quoted strings. */
const column = (table: string, name: string): SQL => sql`${sql.identifier(table)}.${sql.identifier(name)}`;

/** How a write or purge treats the document's rows at positive rowids, and whether it is conditional. */
interface FtsWriteOptions {
    /**
     * A boolean condition checked inside every statement: the write lands only
     * where it holds. The backfill passes "the source row is still the version
     * I read".
     */
    guard?: SQL;

    /**
     * The positive rowids to drop for this document. Absent, every positive row
     * with the document's `__id__` is dropped, which costs a scan of the
     * positive range — nothing once it has drained. The drain, which already
     * knows the rowids it read, passes them to avoid that scan.
     */
    unmappedRowids?: ReadonlyArray<number>;
}

/** The statements dropping one document's positive (unmapped) rows and its mapped row. */
const dropEntry = (companion: string, id: string, { guard, unmappedRowids }: FtsWriteOptions): SQL[] => {
    const map = ftsRowidMapName(companion);
    const guarded = guard === undefined ? sql`` : sql` AND ${guard}`;
    // Past the 100-parameter cap, `sqliteInList` binds the rowids as one JSON array.
    const unmapped =
        unmappedRowids === undefined ? sql`${column(companion, "rowid")} > 0` : sqliteInList(column(companion, "rowid"), unmappedRowids, false, IN_LIST_BUDGET);

    return [
        // Compared as text: a previous build's row may hold a non-text id, and
        // an exact match would then never drop it.
        sql`DELETE FROM ${sql.identifier(companion)} WHERE ${unmapped} AND CAST(${column(companion, FTS_ID_COLUMN)} AS TEXT) = ${id}${guarded}`,
        // `__id__` re-checked: an isolate on the previous build may have purged
        // this rowid and reused it for another document.
        sql`DELETE FROM ${sql.identifier(companion)} WHERE ${column(companion, "rowid")} = (SELECT ${column(map, FTS_ROWID_COLUMN)} FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id}) AND ${column(companion, FTS_ID_COLUMN)} = ${id}${guarded}`,
    ];
};

/** Create the FTS5 companion, its vocabulary view, its rowid map and the rowid-0 sentinel. Idempotent. */
const ftsCompanionDdl = (companion: string): SQL[] => [
    sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(companion)} USING fts5(${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)} UNINDEXED)`,
    // One row per term *instance*, so a term's frequency in a document is a
    // COUNT — what lets the reader rank by the shared scorer in SQL.
    sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(`${companion}__vocab`)} USING fts5vocab(${sql.identifier(companion)}, ${sql.raw("instance")})`,
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(ftsRowidMapName(companion))} (${sql.identifier(FTS_ROWID_COLUMN)} INTEGER PRIMARY KEY, ${sql.identifier(FTS_ID_COLUMN)} TEXT NOT NULL UNIQUE)`,
    // No text, so no term ever matches it, and an id no document has. FTS5
    // does count it as a document of length 0, which shifts `bm25()` (one more
    // document, a lower average length) — but nothing here ranks by bm25: both
    // readers score from the `fts5vocab` instance counts, where it has none.
    sql`INSERT INTO ${sql.identifier(companion)} (rowid, ${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) SELECT 0, '', '' WHERE NOT EXISTS (SELECT 1 FROM ${sql.identifier(companion)} WHERE ${column(companion, "rowid")} = 0)`,
];

/**
 * Write one document's entry at a fresh negative rowid, replacing whatever it
 * had. Run in order, and on D1 as one batch.
 */
const ftsWriteDocument = (companion: string, id: string, text: string, options: FtsWriteOptions = {}): SQL[] => {
    const map = ftsRowidMapName(companion);
    const guarded = options.guard === undefined ? sql`` : sql` AND ${options.guard}`;
    const fresh = sql`MIN(COALESCE((SELECT MIN(${column(map, FTS_ROWID_COLUMN)}) FROM ${sql.identifier(map)}), 0), 0) - 1`;

    return [
        ...dropEntry(companion, id, options),
        sql`INSERT OR REPLACE INTO ${sql.identifier(map)} (${sql.identifier(FTS_ROWID_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) SELECT ${fresh}, ${id} WHERE 1 = 1${guarded}`,
        sql`INSERT OR REPLACE INTO ${sql.identifier(companion)} (rowid, ${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) SELECT ${column(map, FTS_ROWID_COLUMN)}, ${text}, ${column(map, FTS_ID_COLUMN)} FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id}${guarded}`,
    ];
};

/** Remove one document's entry and its mapping. Run in order, and on D1 as one batch. */
const ftsPurgeDocument = (companion: string, id: string, options: FtsWriteOptions = {}): SQL[] => {
    const map = ftsRowidMapName(companion);
    const guarded = options.guard === undefined ? sql`` : sql` AND ${options.guard}`;

    return [...dropEntry(companion, id, options), sql`DELETE FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id}${guarded}`];
};

/**
 * The next `limit` rows the map does not know about — a previous build's, in
 * rowid order, past `after` — as `{ id, rowid }`. The sentinel at rowid 0 is
 * excluded.
 */
const ftsUnmappedPage = (companion: string, limit: number, after = 0): SQL =>
    sql`SELECT ${column(companion, "rowid")} AS ${sql.identifier("rowid")}, ${column(companion, FTS_ID_COLUMN)} AS ${sql.identifier("id")} FROM ${sql.identifier(companion)} WHERE ${column(companion, "rowid")} > ${sql.param(Math.max(0, after))} AND ${column(companion, FTS_ID_COLUMN)} IS NOT NULL ORDER BY ${column(companion, "rowid")} ASC LIMIT ${sql.raw(String(limit))}`;

/** Group a {@link ftsUnmappedPage} result by document id. */
const groupUnmappedRows = (rows: ReadonlyArray<Record<string, unknown>>): Map<string, number[]> => {
    const byId = new Map<string, number[]>();

    for (const row of rows) {
        const id = String(row["id"]);

        byId.set(id, [...(byId.get(id) ?? []), Number(row["rowid"])]);
    }

    return byId;
};

export type { FtsWriteOptions };
export { ftsCompanionDdl, ftsPurgeDocument, ftsRowidMapName, ftsUnmappedPage, ftsWriteDocument, groupUnmappedRows };
