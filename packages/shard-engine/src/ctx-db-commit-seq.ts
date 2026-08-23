/**
 * The `__commit_seq` table: this shard's monotonic commit counter, and the
 * source of the `_commitSeq` system field on a `.commitOrdered()` table.
 *
 * `_creationTime` is wall-clock, and wall-clock does not order commits. Two
 * mutations can be stamped in one order and commit in the other — the clock is
 * read when the handler runs, the write lands when the transaction commits, and
 * nothing ties those two instants together. Any consumer that pages "everything
 * that changed after cursor X" off `_creationTime` therefore has a window in
 * which it can skip a row forever: the row's timestamp is below a cursor the
 * consumer has already passed.
 *
 * `_commitSeq` closes that window. It is a per-shard integer, allocated ONCE per
 * atomic write boundary (every row a mutation writes shares the value) and
 * strictly increasing in commit order, because the allocation happens inside the
 * same `state.storage.transaction(...)` as the writes it stamps and a Durable
 * Object executes one event at a time. A `SELECT … WHERE _commitSeq > cursor
 * ORDER BY _commitSeq` is therefore a complete changefeed over the table.
 *
 * "Per atomic boundary" rather than "per dispatch" is load-bearing. An action is
 * NOT wrapped in a transaction — its external I/O cannot be rolled back — so its
 * writes commit independently and each allocates its own sequence. Sharing one
 * across independently-committed writes would let a consumer checkpoint after the
 * first and never be offered the rest, since they carry a sequence it has already
 * passed. `createShardCtxDb` decides this per write via its `inTransaction`
 * predicate, which reads the host's live transaction state rather than a flag
 * threaded at construction time.
 *
 * Because the sequence groups a commit rather than a row, a BOUNDED page can end
 * in the middle of a group — so a consumer must advance its cursor only to a
 * sequence it has seen the whole of. See the "Checkpoint on a sequence boundary"
 * section of the commit-ordering doc.
 *
 * Two properties callers should NOT read into it:
 *
 * - **It is not gapless.** A mutation that allocates and then throws rolls its
 * writes back, but the counter row rolls back with them — so no gap from an
 * abort. A mutation that allocates, writes to a commit-ordered table, and then
 * has only SOME of its rows survive (a trigger-driven partial) still shares one
 * value. Gaps are nonetheless permitted by the contract, and a consumer must
 * treat the sequence as *ordered*, never as *contiguous*.
 * - **It is per-shard, not global.** Under `.shardBy()` two shards allocate
 * independently and their sequences say nothing about each other. `.global()`
 * tables live in D1 with no shard-local transaction to allocate inside, so
 * `.commitOrdered()` is rejected on them at schema-build time.
 * - **A hard delete is invisible to it.** `_commitSeq` lives on the row, so a
 * physically removed row takes its sequence with it: a consumer paging
 * `_commitSeq > cursor` sees the row stop appearing but is never told it went
 * away, and one holding a materialized copy keeps serving it forever. A
 * `.commitOrdered()` table whose feed must express deletes has to also
 * `.softDelete()` — the tombstone flip is an UPDATE, so it advances the
 * sequence and pages through like any other change.
 *
 * Allocation is lazy: a shard whose schema declares no `.commitOrdered()` table
 * never creates the table, and a mutation that writes no commit-ordered row
 * never touches the counter.
 */

/* eslint-disable unicorn/prevent-abbreviations -- silences the FILENAME rule only (it wants "context-database-commit-seq.ts"); no identifier in this file trips it. "ctx-db-commit-seq" mirrors its parent "ctx-db.ts", the established public module name that ten sibling `ctx-db-*` modules already follow. */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** Reserved single-row table holding this shard's monotonic commit counter. */
const COMMIT_SEQ_TABLE = "__commit_seq";

/**
 * The system field a `.commitOrdered()` table carries. Stored inside the
 * `__doc__` blob rather than as a dedicated column: `documentPath` in
 * `do-sql.ts` maps only `_id` / `_creationTime` onto real columns and falls
 * through to `json_extract` for everything else, so the field is orderable,
 * filterable, and indexable through the machinery that already exists — with no
 * `ALTER TABLE` against rows already on disk.
 */
const COMMIT_SEQ_FIELD = "_commitSeq";

/**
 * Create the counter table and seed its single row. `id` is pinned to `0` by a
 * CHECK so a second row cannot be inserted; `value` is the last sequence handed
 * out (`0` before the first allocation, so the first allocation returns `1` and
 * `0` is always a valid "before everything" cursor).
 */
const migrateCommitSeq = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(COMMIT_SEQ_TABLE)} (
            id INTEGER PRIMARY KEY CHECK (id = 0),
            value INTEGER NOT NULL
        )`,
    );
    runDrizzle(sql, dsql`INSERT OR IGNORE INTO ${dsql.identifier(COMMIT_SEQ_TABLE)} (id, value) VALUES (0, 0)`);
};

/**
 * The highest sequence handed out so far — the resume cursor a changefeed
 * consumer stores. `0` on a shard that has never allocated one.
 *
 * Reads the row directly rather than `MAX(_commitSeq)` over the tables: a
 * consumer that has drained the feed must be able to distinguish "nothing has
 * been written since" from "the newest commit-ordered row was deleted", and
 * only the counter survives the delete.
 * @returns the last allocated sequence, or `0` when none has been.
 */
const readCommitSeq = (sql: SqlExec): number => {
    const [row] = runDrizzle<{ value: number }>(sql, dsql`SELECT value FROM ${dsql.identifier(COMMIT_SEQ_TABLE)} WHERE id = 0`);

    return typeof row?.value === "number" ? row.value : 0;
};

/**
 * Allocate the next sequence and return it.
 *
 * The bump and the read-back are two statements rather than one `UPDATE …
 * RETURNING`: a DO executes one event at a time and nothing awaits between
 * them, so no second allocation can interleave, and nothing else in the engine
 * relies on `RETURNING` against workerd's SQLite yet (see `claimStreamRun` in
 * `durable-stream.ts`, which declines it for the same reason).
 *
 * Callers must memoize the result for the life of one mutation — see
 * `createShardCtxDb`'s `commitSeqForWrite`. Calling this per row would make
 * `_commitSeq` a row counter rather than a commit counter, and rows written by
 * one mutation would no longer compare equal.
 * @returns the freshly allocated sequence (always `>= 1`).
 */
const allocateCommitSeq = (sql: SqlExec): number => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(COMMIT_SEQ_TABLE)} SET value = value + 1 WHERE id = 0`);

    return readCommitSeq(sql);
};

export { allocateCommitSeq, COMMIT_SEQ_FIELD, COMMIT_SEQ_TABLE, migrateCommitSeq, readCommitSeq };
