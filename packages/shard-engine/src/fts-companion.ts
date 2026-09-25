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
 * document id to the FTS5 `rowid` its entry lives at. `__id__` is UNIQUE there
 * and `__rowid__` is the table's own INTEGER PRIMARY KEY. So a purge is two
 * primary-key lookups instead of a scan. A write is `INSERT OR REPLACE` at the
 * mapped rowid, and FTS5 enforces rowid uniqueness, so two concurrent writers of
 * one document converge on one row whatever order their statements interleave
 * in. And a writer that must not overwrite a fresher entry passes a `guard`,
 * checked inside the same statement as the write, so no other writer can land
 * between the check and the write.
 *
 * An external-content FTS5 table (`content=<table>`) was the alternative, and
 * it does not fit: it reads the indexed text back from a column of the source
 * table, and our indexed text is *derived* (a dotted field path, analyzed) — no
 * source column holds it. Its `rowid` would also be the source table's implicit
 * rowid, which `VACUUM` may renumber on a table keyed by a TEXT primary key.
 */

// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { FTS_ID_COLUMN, FTS_TEXT_COLUMN } from "@lunora/search-core";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/** The mapped FTS5 rowid column in {@link ftsRowidMapName}. */
const FTS_ROWID_COLUMN = "__rowid__";

/** The ordinary table mapping a document id to its FTS5 rowid. */
const ftsRowidMapName = (companion: string): string => `${companion}__ids`;

/** `<table>.<column>`, qualified so an unknown name is an error on engines built with double-quoted strings. */
const column = (table: string, name: string): SQL => sql`${sql.identifier(table)}.${sql.identifier(name)}`;

/** Create the FTS5 companion, its vocabulary view and its rowid map. Idempotent. */
const ftsCompanionDdl = (companion: string): SQL[] => [
    sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(companion)} USING fts5(${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)} UNINDEXED)`,
    // One row per term *instance*, so a term's frequency in a document is a
    // COUNT — what lets the reader rank by the shared scorer in SQL.
    sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(`${companion}__vocab`)} USING fts5vocab(${sql.identifier(companion)}, ${sql.raw("instance")})`,
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(ftsRowidMapName(companion))} (${sql.identifier(FTS_ROWID_COLUMN)} INTEGER PRIMARY KEY, ${sql.identifier(FTS_ID_COLUMN)} TEXT NOT NULL UNIQUE)`,
];

/**
 * Bring a companion that predates the rowid map under it. Run once, right after
 * the map is created over a companion that already holds rows.
 *
 * Every existing row is adopted at the rowid it already has. Where a document
 * has more than one row — the duplicate two interleaved backfills used to leave
 * — the newest (highest rowid) is kept and the rest are deleted, since a row
 * the map does not point at could never be purged again. Idempotent, so two
 * cold starts adopting at once converge.
 *
 * Both statements scan the companion once. That is the cost of the migration,
 * paid once; everything after it is keyed.
 */
const adoptFtsCompanion = (companion: string): SQL[] => {
    const map = ftsRowidMapName(companion);

    return [
        sql`INSERT OR IGNORE INTO ${sql.identifier(map)} (${sql.identifier(FTS_ROWID_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) SELECT ${column(companion, "rowid")}, ${column(companion, FTS_ID_COLUMN)} FROM ${sql.identifier(companion)} ORDER BY ${column(companion, "rowid")} DESC`,
        sql`DELETE FROM ${sql.identifier(companion)} WHERE ${column(companion, "rowid")} NOT IN (SELECT ${column(map, FTS_ROWID_COLUMN)} FROM ${sql.identifier(map)})`,
    ];
};

/**
 * Write one document's entry: claim its rowid in the map, then insert-or-replace
 * the FTS5 row at that rowid. Run in order.
 *
 * `guard` is a boolean SQL condition evaluated inside both statements — the
 * backfill passes "the source row is still the version I read", so a page that
 * read a row before a concurrent write cannot overwrite that write's entry.
 */
const ftsWriteDocument = (companion: string, id: string, text: string, guard?: SQL): SQL[] => {
    const map = ftsRowidMapName(companion);
    const guarded = guard === undefined ? sql`` : sql` AND ${guard}`;

    return [
        guard === undefined
            ? sql`INSERT OR IGNORE INTO ${sql.identifier(map)} (${sql.identifier(FTS_ID_COLUMN)}) VALUES (${id})`
            : sql`INSERT OR IGNORE INTO ${sql.identifier(map)} (${sql.identifier(FTS_ID_COLUMN)}) SELECT ${id} WHERE ${guard}`,
        sql`INSERT OR REPLACE INTO ${sql.identifier(companion)} (rowid, ${sql.identifier(FTS_TEXT_COLUMN)}, ${sql.identifier(FTS_ID_COLUMN)}) SELECT ${column(map, FTS_ROWID_COLUMN)}, ${text}, ${column(map, FTS_ID_COLUMN)} FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id}${guarded}`,
    ];
};

/**
 * Remove one document's entry: the FTS5 row by its mapped rowid, then the
 * mapping. Run in order — the FTS5 row goes first, so there is never a moment
 * an entry exists that the map cannot reach.
 */
const ftsPurgeDocument = (companion: string, id: string): SQL[] => {
    const map = ftsRowidMapName(companion);

    return [
        sql`DELETE FROM ${sql.identifier(companion)} WHERE ${column(companion, "rowid")} = (SELECT ${column(map, FTS_ROWID_COLUMN)} FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id})`,
        sql`DELETE FROM ${sql.identifier(map)} WHERE ${column(map, FTS_ID_COLUMN)} = ${id}`,
    ];
};

export { adoptFtsCompanion, ftsCompanionDdl, ftsPurgeDocument, ftsRowidMapName, ftsWriteDocument };
