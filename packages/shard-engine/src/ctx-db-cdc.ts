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

import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { decodeDocJson, encodeDocJson } from "./do-sql";
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

/** Composite index backing every table-filtered changelog read (`("table", seq)`). */
const CDC_LOG_TABLE_SEQ_INDEX = "__cdc_log_table_seq";

/**
 * Create the `__cdc_log` table. `seq` is an `AUTOINCREMENT` primary key, giving
 * each shard a monotonic cursor that streaming-export consumers and replay-PITR
 * page through; `doc` holds the post-image JSON for insert/update and is `NULL`
 * for delete. Only created when CDC is enabled, so non-CDC apps pay nothing.
 *
 * The `("table", seq)` index is not optional bookkeeping: every read the shape
 * path makes is `WHERE "table" [IN …] AND seq > ? ORDER BY seq`, and on the `seq`
 * primary key alone that is a scan in commit order which reads and DISCARDS every
 * row belonging to another table. One busy table then taxes every quiet table's
 * subscribers in proportion to the busy one's write volume. The composite index
 * covers both the filter and the ordering, so a shape reads only its own ops.
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

    runDrizzle(
        sql,
        dsql`CREATE INDEX IF NOT EXISTS ${dsql.identifier(CDC_LOG_TABLE_SEQ_INDEX)} ON ${dsql.identifier(CDC_LOG_TABLE)} (${dsql.identifier("table")}, seq)`,
    );
};

/**
 * Append one committed mutation to the changelog. Called inside the same DO
 * transaction as the row write, so the change is durable iff the write is.
 */
const appendCdcChange = (sql: SqlExec, ts: number, table: string, id: string, op: CdcChange["op"], doc: Record<string, unknown> | undefined): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` column identifies the removed row.
    const docValue = doc === undefined ? null : encodeDocJson(doc);

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(CDC_LOG_TABLE)} (ts, ${dsql.identifier("table")}, id, op, doc) VALUES (${ts}, ${table}, ${id}, ${op}, ${docValue})`,
    );
};

/** Bind a non-empty table set as an `AND "table" IN (?, …)` fragment, or nothing at all for the unfiltered read. */
const tableInClause = (tables: ReadonlySet<string> | undefined): SQL => {
    if (!tables || tables.size === 0) {
        return dsql``;
    }

    // Bind each table name as a parameter so the `IN (…)` list can never inject SQL.
    return dsql` AND ${dsql.identifier("table")} IN (${dsql.join(
        [...tables].map((table) => dsql`${table}`),
        dsql`, `,
    )})`;
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

    // An empty/omitted set leaves the predicate off entirely (full page).
    const tableFilter = tableInClause(options.tables);

    const rows = runDrizzle<{ doc: null | string; id: string; op: string; seq: number; table: string; ts: number }>(
        sql,
        dsql`SELECT seq, ts, ${dsql.identifier("table")}, id, op, doc FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq}${tableFilter} ORDER BY seq ASC LIMIT ${limit}`,
    ).toArray();

    const changes = rows.map((row): CdcChange => {
        const base = { id: row.id, op: row.op as CdcChange["op"], seq: row.seq, table: row.table, ts: row.ts };

        return row.doc === null ? base : { ...base, doc: decodeDocJson(row.doc) };
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/**
 * Does ANY change newer than `sinceSeq` touch one of `tables`? A metadata-only
 * existence probe — it never reads, and never decodes, a `doc`.
 *
 * This is the whole question the subscription resume path asks, and answering it
 * by materializing the changes is what made a long-offline client the most
 * expensive one to serve: reading a bounded page of changes to test
 * `changes.some((c) => readSet.has(c.table))` decoded every post-image in the
 * range, and a client past the page cap could not be proven current at all, so it
 * was re-sent its entire snapshot. Backed by the `("table", seq)` index, this is
 * a single index seek whose cost does not grow with the range.
 *
 * An empty `tables` returns `false`: the caller has no dependency to test, which
 * is never grounds for claiming a change touched it (the resume path treats an
 * unknown read-set as non-resumable before it ever gets here).
 */
const cdcTouchesTables = (sql: SqlExec, sinceSeq: number, tables: ReadonlySet<string>): boolean => {
    if (tables.size === 0) {
        return false;
    }

    const rows = runDrizzle<{ hit: number }>(
        sql,
        dsql`SELECT 1 AS hit FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq}${tableInClause(tables)} LIMIT 1`,
    ).toArray();

    return rows.length > 0;
};

/** One changed row key in a range: the id, the LATEST op that hit it, and that op's `seq`. No post-image. */
interface CdcChangeKey {
    id: string;
    op: CdcChange["op"];
    seq: number;
}

/**
 * The distinct row keys `table` saw change in `(sinceSeq, upTo]`, each carrying
 * the latest op that hit it — the metadata half of the two-stage shape diff.
 *
 * Stage two ({@link import("./ctx-db-shapes").selectShapeMembers}) intersects
 * these ids with the shape's predicate and reads the surviving documents from
 * the table itself, so nothing here needs a post-image: selecting `doc` would
 * decode every changed row in the range to keep only the ones the predicate
 * admits, which for a catch-up over a large range is most of the work and all of
 * the memory.
 *
 * `MAX(seq)` with bare `id`/`op` columns is SQLite's documented single-aggregate
 * behaviour — the bare columns come from the row that supplied the max — and
 * collapses multiple ops on one row to the newest, exactly as the read-then-
 * overwrite drain it replaces did. `seq <= upTo` bounds the read at the
 * checkpoint the poke will be stamped with; the drain it replaces bounded only
 * its loop, so its final page could pull rows past `upTo` into the diff.
 */
const readCdcChangeKeys = (sql: SqlExec, table: string, sinceSeq: number, upTo: number): CdcChangeKey[] => {
    const rows = runDrizzle<{ id: string; op: string; seq: number }>(
        sql,
        dsql`SELECT id, op, MAX(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)}
             WHERE ${dsql.identifier("table")} = ${table} AND seq > ${sinceSeq} AND seq <= ${upTo}
             GROUP BY id
             ORDER BY seq ASC`,
    ).toArray();

    return rows.map((row) => {
        return { id: row.id, op: row.op as CdcChange["op"], seq: row.seq };
    });
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
 * Drop the POST-IMAGES at or below `throughSeq`, keeping the `(seq, table, id,
 * op)` key rows — the cheap tier of a two-tier changelog.
 *
 * A deleted row and a doc-less row are very different answers to a resuming
 * client. Deleting the row destroys the only record that the key changed, so the
 * client cannot be told anything except "re-seed the whole shape". Keeping the
 * key and dropping the payload still answers *which* keys moved, and the shape
 * path reads their current values from the table anyway (see
 * `selectShapeMembers`) — so a client far past payload retention still gets an
 * exact key-level delta instead of a full re-download. Payloads are also where
 * essentially all the bytes are: a key row is a few dozen bytes against a
 * document that is routinely kilobytes.
 *
 * Only a payload consumer — streaming export, replay-PITR ({@link
 * applyCdcChanges}) — genuinely needs the post-image, and compaction is opt-in
 * (`LUNORA_CDC_PAYLOAD_RETENTION`) precisely because this shard cannot see where
 * such a consumer's cursor sits. What protects them is the READ path, not the
 * sweep: `ShardDO.runShardCdcSync` refuses to serve a page containing a
 * doc-less insert/update and raises `CDC_PAYLOAD_COMPACTED`, so a consumer
 * re-syncs from a snapshot instead of silently recording a compacted row as a
 * delete.
 */
const compactCdcDocs = (sql: SqlExec, throughSeq: number): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the storage-level "payload dropped"; the key columns stay.
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(CDC_LOG_TABLE)} SET doc = ${null} WHERE seq <= ${throughSeq} AND doc IS NOT NULL`);
};

/**
 * Oldest `seq` whose post-image is still retained, or `undefined` when no row in
 * the log carries one. Distinct from {@link minCdcSeq} (the oldest retained
 * KEY): after {@link compactCdcDocs} the two diverge, and a consumer that needs
 * post-images — streaming export, replay-PITR — must gate on this one while the
 * shape path gates on `minCdcSeq`.
 *
 * A `delete` op legitimately stores a NULL post-image, so this deliberately
 * measures "a row that still has a doc" rather than "a row that should have
 * one": a range whose only entries are deletes reports the first doc-bearing row
 * after it, which is the conservative direction (it can only make a payload
 * consumer re-seed, never read a payload that was compacted away).
 */
const minCdcDocSeq = (sql: SqlExec): number | undefined => {
    const rows = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT MIN(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE doc IS NOT NULL`).toArray();

    return rows[0]?.seq ?? undefined;
};

/**
 * Number of rows currently in the changelog — what a retention sweep measures a
 * row-count cap against. Cheap on SQLite (`COUNT(*)` over the `seq` primary
 * key), and read once per sweep rather than per write.
 */
const countCdcChanges = (sql: SqlExec): number => {
    const rows = runDrizzle<{ count: null | number }>(sql, dsql`SELECT COUNT(*) AS count FROM ${dsql.identifier(CDC_LOG_TABLE)}`).toArray();

    return rows[0]?.count ?? 0;
};

/**
 * The `seq` that leaves exactly `keep` rows behind it — i.e. the largest cutoff a
 * sweep may trim/compact through when honouring a row-count cap. Returns
 * `undefined` when the log already holds `keep` rows or fewer (nothing to do).
 *
 * Computed with `LIMIT 1 OFFSET keep - 1` over descending `seq` rather than
 * arithmetic on the cursor: `seq` has gaps (a trimmed prefix, a rolled-back
 * transaction), so `cursor - keep` would trim a variable and occasionally very
 * large number of extra rows.
 */
const cdcSeqLeavingRows = (sql: SqlExec, keep: number): number | undefined => {
    if (keep <= 0) {
        // Keep nothing: every retained row is past the window, so the cutoff is
        // the newest `seq` present. Deliberately MAX over the live rows rather
        // than the AUTOINCREMENT high-watermark — the latter survives a trim and
        // would name a seq no row has.
        const head = runDrizzle<{ seq: null | number }>(sql, dsql`SELECT MAX(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)}`).toArray();

        return head[0]?.seq ?? undefined;
    }

    const rows = runDrizzle<{ seq: number }>(
        sql,
        dsql`SELECT seq FROM ${dsql.identifier(CDC_LOG_TABLE)} ORDER BY seq DESC LIMIT 1 OFFSET ${keep - 1}`,
    ).toArray();

    const oldestKept = rows[0]?.seq;

    return oldestKept === undefined ? undefined : oldestKept - 1;
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
        const fields = { ...document };

        delete fields["_id"];

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
    CDC_LOG_TABLE_SEQ_INDEX,
    CDC_META_TABLE,
    cdcSeqLeavingRows,
    cdcTouchesTables,
    compactCdcDocs,
    countCdcChanges,
    migrateCdcLog,
    migrateCdcMeta,
    minCdcDocSeq,
    minCdcSeq,
    readCdcChangeKeys,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    trimCdcChanges,
};
export type { CdcChange, CdcChangeKey };
