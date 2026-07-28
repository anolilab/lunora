/**
 * Change-data-capture for the DO store: the append-only `__cdc_log` changelog,
 * the single-row `__cdc_meta` epoch, and CDC replay against a live writer.
 *
 * Extracted from `ctx-db.ts` as a cohesive unit — it touches the store only
 * through `SqlExec` (log/meta) and `DatabaseWriterLike` (replay). The changelog
 * backs streaming export + delta-resume subscriptions; the epoch detects a
 * forked timeline; replay drives point-in-time recovery. `ctx-db.ts` re-exports
 * these so existing import sites (shard-do, the index barrel, tests) are unchanged.
 */

/* eslint-disable no-restricted-syntax -- every `dsql\`…\`` here is a drizzle tagged-template SQL builder binding a value, not a string conversion; the rule misfires on the inner TemplateLiteral (see where-sql.ts). */
/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-cdc" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { ConflictError } from "./transaction";

/** Reserved append-only changelog table backing CDC streaming export and replay-PITR. */
const CDC_LOG_TABLE = "__cdc_log";

/** One change-data-capture entry: a committed mutation, in monotonic `seq` order. */
interface CdcChange {
    /** Post-image document for insert/update; absent for delete (the `id` identifies the removed row). */
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    table: string;
    /** Wall-clock millis when the change committed (the ctx-db `clock`). */
    ts: number;
}

/**
 * Create the `__cdc_log` table. `seq` is an `AUTOINCREMENT` primary key, giving
 * each shard a monotonic cursor that streaming-export consumers and replay-PITR
 * page through; `doc` holds the post-image JSON for insert/update and is `NULL`
 * for delete. Only created when CDC is enabled, so non-CDC apps pay nothing.
 */
const migrateCdcLog = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(CDC_LOG_TABLE)} (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            ${dsql.identifier("table")} TEXT NOT NULL,
            id TEXT NOT NULL,
            op TEXT NOT NULL,
            doc TEXT
        )`,
    );
};

/**
 * Append one committed mutation to the changelog. Called inside the same DO
 * transaction as the row write, so the change is durable iff the write is.
 */
const appendCdcChange = (sql: SqlExec, ts: number, table: string, id: string, op: CdcChange["op"], doc: Record<string, unknown> | undefined): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` column identifies the removed row.
    const docValue = doc === undefined ? null : JSON.stringify(doc);

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(CDC_LOG_TABLE)} (ts, ${dsql.identifier("table")}, id, op, doc) VALUES (${ts}, ${table}, ${id}, ${op}, ${docValue})`,
    );
};

/**
 * Read changelog entries newer than `sinceSeq` in commit order, up to `limit`
 * (clamped to [1, 10000]). Returns the rows plus the cursor to resume from (the
 * last `seq`, or `sinceSeq` when the page is empty).
 *
 * The optional `tables` set narrows the page to changes on those tables — the
 * shape/poke path reads one filtered page per flush so it never scans op-log
 * entries for tables no live shape is watching. Omit it (or pass an empty set)
 * for the full, unfiltered page (the existing streaming-export/resume callers).
 */
const readCdcChanges = (
    sql: SqlExec,
    options: { limit?: number; sinceSeq?: number; tables?: ReadonlySet<string> } = {},
): { changes: CdcChange[]; cursor: number } => {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));

    // Bind each table name as a parameter so the `IN (…)` list can never inject
    // SQL; an empty/omitted set leaves the predicate off entirely (full page).
    const tableFilter =
        options.tables && options.tables.size > 0
            ? dsql` AND ${dsql.identifier("table")} IN (${dsql.join(
                  [...options.tables].map((table) => dsql`${table}`),
                  dsql`, `,
              )})`
            : dsql``;

    const rows = runDrizzle<{ doc: null | string; id: string; op: string; seq: number; table: string; ts: number }>(
        sql,
        dsql`SELECT seq, ts, ${dsql.identifier("table")}, id, op, doc FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq}${tableFilter} ORDER BY seq ASC LIMIT ${limit}`,
    ).toArray();

    const changes = rows.map((row): CdcChange => {
        const base = { id: row.id, op: row.op as CdcChange["op"], seq: row.seq, table: row.table, ts: row.ts };

        return row.doc === null ? base : { ...base, doc: JSON.parse(row.doc) as Record<string, unknown> };
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/**
 * Drop changelog entries at or below a checkpointed `throughSeq` — retention
 * after a consumer has durably advanced past them, so the log can't grow
 * unbounded.
 */
const trimCdcChanges = (sql: SqlExec, throughSeq: number): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq <= ${throughSeq}`);
};

/**
 * Current high-watermark of this shard's changelog — the largest `seq` ever
 * written, or `0` when the log is empty. This is the cursor a `data`/`delta`
 * frame advertises so a reconnecting subscriber can resume from it. Because
 * `seq` is `AUTOINCREMENT`, `MAX(seq)` survives a `trimCdcChanges` that deletes
 * the row carrying the high-watermark, so the cursor never goes backwards.
 */
const readCdcCursor = (sql: SqlExec): number => {
    // `seq_autoincrement` in sqlite_sequence holds the last allocated rowid for
    // an AUTOINCREMENT column and is NOT reset by DELETE, so it keeps the true
    // high-watermark even after the newest row is trimmed. Fall back to
    // MAX(seq) when the sequence row is absent (no insert yet).
    const seqRow = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT seq FROM sqlite_sequence WHERE name = ${CDC_LOG_TABLE}`).toArray();
    const fromSequence = seqRow[0]?.seq;

    if (typeof fromSequence === "number") {
        return fromSequence;
    }

    const rows = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT MAX(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)}`).toArray();

    return rows[0]?.seq ?? 0;
};

/**
 * Oldest `seq` still retained in the changelog, or `undefined` when the log is
 * empty. A reconnecting subscriber whose `sinceSeq` is below `floor - 1` has
 * missed changes that `trimCdcChanges` already compacted away, so it must take a
 * full snapshot instead of a delta resume.
 */
const minCdcSeq = (sql: SqlExec): number | undefined => {
    const rows = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT MIN(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)}`).toArray();

    return rows[0]?.seq ?? undefined;
};

/**
 * Single-row table holding this shard's CDC **epoch** — an opaque token that
 * changes whenever the changelog timeline forks (a `reset` that recreates the
 * log, or a fresh shard reusing a recycled Durable Object id). The `seq` cursor
 * alone can't detect such a fork: after a reset/rollback the AUTOINCREMENT
 * counter restarts low, so a client holding an old high `sinceSeq` would be
 * told "resumable" against the new, unrelated timeline and keep forked data.
 * Pairing the epoch with the cursor closes that hole — a subscriber resumes
 * only when BOTH the epoch matches and the cursor is in range.
 */
const CDC_META_TABLE = "__cdc_meta";

/** Create the single-row CDC-meta table (idempotent). The `id = 1` check pins it to exactly one row. */
const migrateCdcMeta = (sql: SqlExec): void => {
    runDrizzle(sql, dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(CDC_META_TABLE)} (id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL)`);
};

/**
 * This shard's current CDC epoch, minting and persisting a fresh one on first
 * read. Stamped on every `data`/`delta`/`resume` frame next to the cursor so a
 * reconnecting client can prove it is resuming the same timeline it cached.
 */
const readCdcEpoch = (sql: SqlExec): string => {
    migrateCdcMeta(sql);

    const rows = runDrizzle<{ epoch: string }>(sql, dsql`SELECT epoch FROM ${dsql.identifier(CDC_META_TABLE)} WHERE id = 1`).toArray();
    const existing = rows[0]?.epoch;

    if (typeof existing === "string" && existing.length > 0) {
        return existing;
    }

    const minted = crypto.randomUUID();

    runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(CDC_META_TABLE)} (id, epoch) VALUES (1, ${minted})`);

    return minted;
};

/**
 * Roll the CDC epoch to a fresh value — called whenever the changelog timeline
 * is reset (the log is dropped/recreated), so any subscriber still holding the
 * prior epoch is forced to re-snapshot instead of resuming onto a forked log.
 */
const bumpCdcEpoch = (sql: SqlExec): string => {
    migrateCdcMeta(sql);

    const next = crypto.randomUUID();

    // Upsert the single row so a bump works whether or not an epoch existed yet.
    runDrizzle(sql, dsql`INSERT INTO ${dsql.identifier(CDC_META_TABLE)} (id, epoch) VALUES (1, ${next}) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch`);

    return next;
};

/**
 * Replay a CDC change against a live writer: insert/update post-images become
 * an upsert (insert with the explicit id, falling back to replace when the row
 * already exists), deletes remove the row. This is the engine behind
 * point-in-time recovery — apply a base snapshot, then replay the changelog up
 * to the target moment in commit order.
 */
const applyCdcChange = async (writer: DatabaseWriterLike, change: CdcChange): Promise<void> => {
    if (change.op === "delete") {
        await writer.delete(change.id, change.table);

        return;
    }

    const document = change.doc ?? {};

    try {
        await writer.insert(change.table, document, { allowExplicitId: true });
    } catch (error: unknown) {
        if (!(error instanceof ConflictError)) {
            throw error;
        }

        // Row already exists — replace its fields. Drop only `_id` (replace
        // takes the id as its first argument). KEEP `_creationTime` and pass the
        // trusted-replay `allowExplicitId` opt-in so `replace` preserves the
        // row's original creation time instead of resetting it to the replay
        // clock (the default mutation path mints a fresh `clock()`).
        const fields: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(document)) {
            if (key !== "_id") {
                fields[key] = value;
            }
        }

        await writer.replace(change.id, fields, undefined, { allowExplicitId: true });
    }
};

/**
 * Replay an ordered batch of CDC changes against a writer (see
 * {@link applyCdcChange}). Applied sequentially so per-row order is preserved —
 * a later update never races the insert it depends on.
 */
const applyCdcChanges = async (writer: DatabaseWriterLike, changes: ReadonlyArray<CdcChange>): Promise<void> => {
    for (const change of changes) {
        // eslint-disable-next-line no-await-in-loop -- replay MUST be sequential: per-row commit order is the correctness contract.
        await applyCdcChange(writer, change);
    }
};

export {
    appendCdcChange,
    applyCdcChanges,
    bumpCdcEpoch,
    CDC_LOG_TABLE,
    CDC_META_TABLE,
    migrateCdcLog,
    migrateCdcMeta,
    minCdcSeq,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    trimCdcChanges,
};
export type { CdcChange };
