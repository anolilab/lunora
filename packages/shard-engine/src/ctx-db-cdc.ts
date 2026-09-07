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

import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import { runDrizzle, runSql } from "./do-exec";
import { decodeDocJson, encodeDocJson } from "./do-sql";
import { ConflictError } from "./transaction";

/** Reserved append-only changelog table backing CDC streaming export and replay-PITR. */
const CDC_LOG_TABLE = "__cdc_log";

/**
 * The changelog append, as text. Fully constant — one table, fixed columns, every
 * value bound — and it runs once per committed mutation, so building it through
 * a drizzle template per write was pure overhead (see `row-statements.ts`, which
 * holds the per-table statements for the same reason; this one lives here
 * because the table name is private to this module).
 *
 * `__tests__/row-statements.test.ts` pins this against what the template rendered.
 */
const CDC_APPEND_SQL = `INSERT INTO ${quoteIdentifier(CDC_LOG_TABLE)} (ts, ${quoteIdentifier("table")}, id, op, doc) VALUES (?, ?, ?, ?, ?)`;

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

    // Isolated from the table's own migration, because this statement is the one
    // that can be EXPENSIVE rather than instant. `IF NOT EXISTS` makes it
    // idempotent; it does not make it cheap. On an existing deployment upgrading
    // into this index, the first cold start builds it over however many rows the
    // log accumulated while it had no retention — and that build runs
    // synchronously on the request path. If it exceeds the isolate's budget and
    // takes the whole migration down with it, EVERY subsequent request restarts
    // from scratch and the shard is bricked rather than slow.
    //
    // Letting it fail alone converts that into the recoverable shape: the log
    // still works (reads fall back to the `seq` scan they used before this index
    // existed), the retention sweep bounds the log over the following minutes,
    // and the next cold start retries against a smaller table until it succeeds.
    try {
        runDrizzle(
            sql,
            dsql`CREATE INDEX IF NOT EXISTS ${dsql.identifier(CDC_LOG_TABLE_SEQ_INDEX)} ON ${dsql.identifier(CDC_LOG_TABLE)} (${dsql.identifier("table")}, seq)`,
        );
    } catch {
        /* see above: a degraded read path beats an unbootable shard, and the next cold start retries */
    }
};

/**
 * Append one committed mutation to the changelog. Called inside the same DO
 * transaction as the row write, so the change is durable iff the write is.
 */
const appendCdcChange = (sql: SqlExec, ts: number, table: string, id: string, op: CdcChange["op"], doc: Record<string, unknown> | undefined): void => {
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` column identifies the removed row.
    const docValue = doc === undefined ? null : encodeDocJson(doc);

    runSql(sql, CDC_APPEND_SQL, ts, table, id, op, docValue);
};

/**
 * How many table names one `IN (…)` filter may bind. Workerd caps a statement at
 * 100 bound parameters; the callers here spend one or two on the range bounds, so
 * this leaves headroom rather than sitting on the limit.
 */
const CDC_TABLE_FILTER_CHUNK = 90;

/**
 * Bind one non-empty chunk of table names as an `AND "table" IN (?, …)`
 * fragment. Chunking is the caller's job — the only caller is
 * {@link cdcTouchesTables}, which splits an unbounded read-set at
 * {@link CDC_TABLE_FILTER_CHUNK} so the statement stays inside workerd's
 * 100-bound-parameter cap. A helper that silently accepted the whole set would
 * put that cap one call site away again.
 */
const tableInClause = (tables: ReadonlySet<string>): SQL =>
    // Bind each table name as a parameter so the `IN (…)` list can never inject SQL.
    dsql` AND ${dsql.identifier("table")} IN (${dsql.join(
        [...tables].map((table) => dsql`${table}`),
        dsql`, `,
    )})`;

/**
 * Read changelog entries newer than `sinceSeq` in commit order, up to `limit`
 * (clamped to [1, 10000]). Returns the rows plus the cursor to resume from (the
 * last `seq`, or `sinceSeq` when the page is empty). Every table's changes are
 * in the page — this is the whole-log reader, used by the streaming
 * export/resume and archive-sweep callers.
 *
 * There is deliberately no table filter. One was carried here for the shape/poke
 * path, which reads per table — but that path goes through
 * {@link readCdcChangeKeys}, which takes a single `table` and returns keys
 * without post-images, so nothing ever passed the set. Restoring it is not one
 * predicate: `tableInClause` binds a parameter per name against workerd's cap of
 * 100, and chunking an ORDERED, LIMIT-ed page is not the loop
 * {@link cdcTouchesTables} gets away with — the chunks would have to be merged
 * back into commit order and the cursor re-derived from the merge, or the page
 * silently truncates at whichever chunk filled `limit` first.
 */
const readCdcChanges = (sql: SqlExec, options: { limit?: number; sinceSeq?: number } = {}): { changes: CdcChange[]; cursor: number } => {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));

    const rows = runDrizzle<{ doc: null | string; id: string; op: string; seq: number; table: string; ts: number }>(
        sql,
        dsql`SELECT seq, ts, ${dsql.identifier("table")}, id, op, doc FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq} ORDER BY seq ASC LIMIT ${limit}`,
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
 *
 * The read-set is chunked because it is unbounded — it is however many tables one
 * query happened to read — while workerd caps a statement at 100 bound
 * parameters, and `sinceSeq` already spends one. A wide read-set would otherwise
 * throw here rather than answer, turning a resumable subscription into an error
 * on the seed path.
 */
const cdcTouchesTables = (sql: SqlExec, sinceSeq: number, tables: ReadonlySet<string>): boolean => {
    if (tables.size === 0) {
        return false;
    }

    const names = [...tables];

    for (let index = 0; index < names.length; index += CDC_TABLE_FILTER_CHUNK) {
        const chunk = new Set(names.slice(index, index + CDC_TABLE_FILTER_CHUNK));

        const rows = runDrizzle<{ hit: number }>(
            sql,
            dsql`SELECT 1 AS hit FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq}${tableInClause(chunk)} LIMIT 1`,
        ).toArray();

        if (rows.length > 0) {
            return true;
        }
    }

    return false;
};

/**
 * Can the changelog speak for EVERY entry in a subscription's read-set?
 *
 * This is the question {@link cdcTouchesTables} silently assumes the answer to.
 * That probe reports "no change" for a dependency the log never records, and a
 * "no change" the log cannot actually vouch for is indistinguishable on the wire
 * from a genuine one — the resuming client keeps a stale value forever.
 *
 * The log records writes to THIS shard's own SQLite tables and nothing else, so
 * a great deal of what a query can read is invisible to it. A `.global()` table
 * lives in D1 and no DO ever appends a CDC entry for it, so a write by ANY shard
 * leaves this log untouched. The `"*"` wildcard an admin/flags read stamps names
 * no table at all, and a flag flipped in the provider never touches SQLite.
 * `ctx.kv`, `ctx.storage`, `ctx.vectors`, `ctx.system`, and a wall-clock
 * predicate like `_creationTime > now - 1h` leave no row-level trace anywhere in
 * the log either.
 *
 * So the vouchable set is defined POSITIVELY, and read from the storage itself
 * rather than from a list someone has to remember to extend: a dependency is
 * vouchable iff a table of that name exists in this DO's SQLite. Anything else —
 * a `.global()` table, a sentinel, a dependency stamped by a capability added
 * after this was written — falls to the default, and the default is "cannot
 * vouch". Getting the classification wrong then costs a needless re-snapshot
 * instead of silently serving stale data.
 *
 * **One local table is nevertheless unvouchable, and it is the one exception to
 * the paragraph above.** "Exists in this DO's SQLite" was meant as a proxy for
 * "is a table `recordCdc` appends for", and a `.memory()` table breaks the two
 * apart: migrations create it like any other (only its rows are cleared on
 * eviction), so it is in `sqlite_master` — but `recordCdc` deliberately skips it,
 * so the log holds no record of it and "nothing changed" is a claim this function
 * cannot support. Rather than teach the catalog scan about a schema fact it
 * cannot see, `ctx-db.ts` stamps {@link import("./read-footprint").UNVOUCHABLE_DEP}
 * on every read of a memory table, which lands the read-set in the default branch
 * where it belongs. A read-set assembled by hand rather than by the read
 * footprint therefore still gets the naive answer for a memory table — the
 * footprint is the only supported producer.
 *
 * The live-refresh path is already pessimistic in exactly this way (see
 * `writeTouchesMemo` in `subscription-range-gate.ts` — "assume touched on any
 * uncertainty"); this is the resume path agreeing with it.
 *
 * An EMPTY read-set is unvouchable for the same reason and not a special case:
 * a query whose dependencies were never recorded may well read a global table,
 * so "nothing changed locally" proves nothing about it.
 *
 * Reads the whole `sqlite_master` table list rather than probing the read-set
 * names with an `IN (…)`: a shard holds tens of tables, and binding one
 * parameter per dependency would walk into workerd's 100-bound-parameter cap on
 * a wide read-set.
 */
const localTableCache = new WeakMap<object, Set<string>>();

/** Every physical table in this DO's SQLite. */
const readLocalTables = (sql: SqlExec): Set<string> =>
    new Set(
        runDrizzle<{ name: string }>(sql, dsql`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .toArray()
            .map((row) => row.name),
    );

const cdcCanVouchFor = (sql: SqlExec, deps: ReadonlySet<string>): boolean => {
    if (deps.size === 0) {
        return false;
    }

    // The catalog is memoized per `sql` handle, because it moves only when a
    // migration runs while this question is asked on every resume evaluation —
    // and that is the hot path the whole two-stage read exists to keep flat
    // (measured: the uncached scan cost ~18% of `evaluateResume`).
    //
    // Only a POSITIVE answer is ever cached. A dep the cache does not know
    // re-reads the catalog once and retries, so a table created after the cache
    // was built is picked up rather than being refused forever; and because a
    // miss always re-reads, the cache can never turn a vouchable dep into a
    // refusal. The reverse — a table DROPPED after being cached — would leave a
    // stale vouch, but a query whose dependency no longer exists cannot read it
    // to begin with, so no live subscription can hold one.
    let local = localTableCache.get(sql);
    let reread = false;

    if (local === undefined) {
        local = readLocalTables(sql);
        reread = true;
        localTableCache.set(sql, local);
    }

    for (const dep of deps) {
        if (local.has(dep)) {
            continue;
        }

        if (reread) {
            return false;
        }

        local = readLocalTables(sql);
        reread = true;
        localTableCache.set(sql, local);

        if (!local.has(dep)) {
            return false;
        }
    }

    return true;
};

/** One changed row key in a range: the id, the LATEST op that hit it (`update` whenever more than one did — see {@link readCdcChangeKeys}), and that op's `seq`. No post-image. */
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
 * overwrite drain it replaces did. (`COUNT(*)` rides along without disturbing
 * that: the rule needs exactly one `min()`/`max()` in the query, not exactly one
 * aggregate.) `seq <= upTo` bounds the read at the checkpoint the poke will be
 * stamped with; the drain it replaces bounded only its loop, so its final page
 * could pull rows past `upTo` into the diff.
 *
 * **A collapsed group never reports `insert`.** {@link import("./shape-diff").buildShapeDiff}
 * skips a non-member whose op is `insert`, on the sound ground that a row which
 * never matched the predicate was never replicated, so a `delete` for it would
 * spam every subscriber on the table. That ground only holds for a key whose
 * insert is the ONLY op in the window. A hard `delete` followed by a re-insert of
 * the same `_id` inside one poke window collapses to `insert` here — and that key
 * HAD been replicated, so skipping it leaves the pre-delete row on the client
 * forever. A multi-op group is reported as `update` instead: for a member it is
 * the more accurate client-facing kind anyway (the client may already hold the
 * key), and for a non-member it is what earns the `delete` the client needs.
 */
const readCdcChangeKeys = (sql: SqlExec, table: string, sinceSeq: number, upTo: number): CdcChangeKey[] => {
    // `maxSeq`, not a second `seq`: aliasing the aggregate to the name of the
    // column it aggregates leaves `ORDER BY seq` resolvable two ways, and which
    // one wins is an engine rule rather than something stated here.
    const rows = runDrizzle<{ id: string; maxSeq: number; op: string; ops: number }>(
        sql,
        dsql`SELECT id, op, MAX(seq) AS maxSeq, COUNT(*) AS ops FROM ${dsql.identifier(CDC_LOG_TABLE)}
             WHERE ${dsql.identifier("table")} = ${table} AND seq > ${sinceSeq} AND seq <= ${upTo}
             GROUP BY id
             ORDER BY maxSeq ASC`,
    ).toArray();

    return rows.map((row) => {
        const op = row.op as CdcChange["op"];

        return { id: row.id, op: op === "insert" && row.ops > 1 ? "update" : op, seq: row.maxSeq };
    });
};

/**
 * Drop changelog entries at or below a checkpointed `throughSeq` — retention
 * after a consumer has durably advanced past them, so the log can't grow
 * unbounded. Deletes at most `maxRows` per call, oldest first.
 *
 * The bound is not a nicety. A retention sweep runs on a write path, and its
 * first run after an operator enables retention faces the whole accumulated log
 * — the exact situation the knob was turned on for. An unbounded `DELETE` over
 * millions of rows there is not merely slow: if it exceeds the DO's per-request
 * limits it aborts having changed nothing, and the next sweep issues the
 * identical unbounded statement. That loop never makes progress and never
 * reports why. Bounding each pass makes a large backlog take many sweeps instead
 * of never finishing.
 */
const trimCdcChanges = (sql: SqlExec, throughSeq: number, maxRows: number): void => {
    runDrizzle(
        sql,
        dsql`DELETE FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq IN (
            SELECT seq FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq <= ${throughSeq} ORDER BY seq ASC LIMIT ${maxRows}
        )`,
    );
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
const compactCdcDocs = (sql: SqlExec, throughSeq: number, maxRows: number): void => {
    // `SET doc = NULL` as a SQL literal, not a bound `${null}`: the storage-level
    // "payload dropped" is a property of the statement, not a value the caller
    // supplies, and binding it invites an implicit JS-to-string conversion on the
    // way through the driver.
    //
    // Bounded per call like {@link trimCdcChanges}, and for the same reason. The
    // `doc IS NOT NULL` filter sits INSIDE the bounded prefix rather than beside
    // it, so a batch is `maxRows` rows that actually need compacting — outside,
    // a prefix of already-compacted rows would consume the whole batch and the
    // sweep would stall short of the rows carrying the bytes.
    runDrizzle(
        sql,
        dsql`UPDATE ${dsql.identifier(CDC_LOG_TABLE)} SET doc = NULL WHERE seq IN (
            SELECT seq FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE seq <= ${throughSeq} AND doc IS NOT NULL ORDER BY seq ASC LIMIT ${maxRows}
        )`,
    );
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
 * Is `sinceSeq` below the retained window a floor of `floor` describes?
 *
 * Six call sites across three packages ask this, and the `+ 1` is why it is
 * stated once: a consumer sitting at `sinceSeq` has SEEN everything up to and
 * including it and expects `sinceSeq + 1` next, so a floor of exactly
 * `sinceSeq + 1` is the boundary case where nothing was missed. A `>` written as
 * `>=` at any one site fails silently in one of the two directions the log has
 * no way to report: a permanently re-seeding client, or a served gap.
 *
 * An `undefined` floor means an EMPTY log, and this returns `false` for it —
 * "nothing retained" is not "your cursor is below what is retained". The callers
 * that must also refuse an empty log say so themselves, at the call site, so the
 * two questions stay visibly distinct rather than folded into one predicate that
 * answers whichever the reader assumed.
 *
 * Deliberately not a `floor is number` type predicate, tempting as that is for
 * the throwing callers: the FALSE branch would then narrow `floor` to
 * `undefined`, and the predicate is false for a perfectly defined floor the
 * cursor happens to sit inside. A caller that needs the value re-checks it, in
 * one visible token.
 */
const cursorBelowRetainedFloor = (floor: number | undefined, sinceSeq: number): boolean => floor !== undefined && floor > sinceSeq + 1;

/**
 * The refusal a read path returns when {@link cursorBelowRetainedFloor} holds.
 *
 * One builder rather than the message written out per path: the remediation
 * ("resume from a snapshot") is the same everywhere, and two copies drift the
 * moment one is reworded. `scope` names which log — the shard's own, or the
 * `.global()` one — since the answer for a consumer differs by which.
 */
const cdcTrimmedError = (floor: number, sinceSeq: number, scope: "global" | "shard"): LunoraError =>
    new LunoraError(
        "CDC_LOG_TRIMMED",
        `${scope === "global" ? "global cdc" : "cdc"} entries at or below seq ${String(floor - 1)} have been trimmed; resume from a snapshot (sinceSeq ${String(sinceSeq)} is below the retained window)`,
        { status: 409 },
    );

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
 * The oldest `seq` a PAYLOAD consumer — streaming export, replay-PITR, a region
 * read replica — can still be replayed from. Distinct from {@link minCdcSeq},
 * which is the oldest retained KEY and is what the shape path gates on: after
 * {@link compactCdcDocs} the two diverge, and the difference is a range whose
 * keys survive but whose documents do not.
 *
 * Measured as "past the newest row that SHOULD carry a post-image and doesn't",
 * which is the same test `ShardDO.runShardCdcSync` applies per page — stated
 * once, so the read path's refusal and the floor a consumer is told to bootstrap
 * from can never disagree. The inverse framing ("oldest row that still has a
 * doc") looks equivalent and is not: a `delete` stores a NULL post-image by
 * design, so a perfectly replayable log whose retained prefix happens to open
 * with deletes would report a floor above rows it can serve, and force needless
 * bootstraps.
 *
 * Compaction only ever clears a prefix, so one `MAX` answers it. Folds in
 * {@link minCdcSeq} as well: a trimmed row is no more replayable than a
 * compacted one, and every caller wants the higher of the two.
 */
const minCdcReplayableSeq = (sql: SqlExec): number | undefined => {
    const rows = runDrizzle<{ seq: null | number }>(
        sql,
        dsql`SELECT MAX(seq) AS seq FROM ${dsql.identifier(CDC_LOG_TABLE)} WHERE op <> 'delete' AND doc IS NULL`,
    ).toArray();

    const compactedThrough = rows[0]?.seq ?? undefined;
    const trimFloor = minCdcSeq(sql);

    if (compactedThrough === undefined) {
        return trimFloor;
    }

    return Math.max(compactedThrough + 1, trimFloor ?? 0);
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
        //
        // `change.table` is passed as `expectedTable` like the delete and insert
        // above: an unscoped `replace` probes every table on the premise that ids
        // are unique across them, which `.source()` tables break — `liftSourceId`
        // sets `_id` to the upstream natural primary key, so an orders update
        // lands in the users row.
        const fields = { ...document };

        delete fields["_id"];

        await writer.replace(change.id, fields, change.table, { allowExplicitId: true });
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
    cdcCanVouchFor,
    cdcSeqLeavingRows,
    cdcTouchesTables,
    cdcTrimmedError,
    compactCdcDocs,
    cursorBelowRetainedFloor,
    migrateCdcLog,
    migrateCdcMeta,
    minCdcReplayableSeq,
    minCdcSeq,
    readCdcChangeKeys,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    trimCdcChanges,
};
export type { CdcChange, CdcChangeKey };

export { CDC_APPEND_SQL };
