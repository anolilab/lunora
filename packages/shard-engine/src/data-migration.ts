/**
 * Per-shard online data-migration runner.
 *
 * `runDataMigration` walks one table's live documents in keyset batches and
 * applies a {@link DataMigrationLike}'s `up` (or `down`) transform to each row,
 * rewriting changed rows through the normal {@link DatabaseWriterLike} path so
 * triggers fire and subscribers are notified. It runs *inside* a shard's
 * Durable Object — the cross-shard orchestrator invokes it once per shard.
 *
 * Two properties make it safe to interrupt and re-invoke:
 *
 * - **Resumable.** Progress (cursor, counts, status) is persisted to a reserved
 * `__lunora_migrations` table after every batch. A run that resumes the same
 * id+direction picks up from the stored cursor instead of rescanning.
 * - **Idempotent on completion.** Re-running a migration already `completed` in
 * the same direction is a no-op that returns the recorded counts.
 *
 * Cursor stability is the linchpin: iteration uses the default
 * `_creationTime ASC, id ASC` order, and `replace` preserves both `_id` and
 * `_creationTime`, so rewriting a row never moves it relative to the cursor —
 * each row is visited exactly once even as the batch ahead of us is rewritten.
 * The cursor advances PER ROW, not per batch, so that claim survives a failure:
 * persisting the page-start cursor on a mid-batch throw would re-walk every row
 * of the failed batch on resume, re-applying a non-idempotent transform (the
 * `version + 1` shape) to rows it had already rewritten.
 *
 * The page is also re-read per row before it is rewritten — see
 * {@link applyTransformToRow}. A page of `batchSize` documents is up to that many
 * `await`s old by the time its last row is written, and `writer.replace` only
 * compare-and-swaps on the snapshot IT reads, so without the re-read a live
 * mutation landing mid-batch was overwritten with the pre-mutation value.
 *
 * `dryRun` previews counts from a fresh scan without touching either the data
 * rows or the state table.
 */

import { LunoraError } from "@lunora/errors";

import { stableWireKey } from "../../../shared/wire-key";
import type { SqlExec } from "./ctx-db";
import { runSql } from "./do-exec";
import { CURSOR_PREFIX, encodeCursor } from "./query-args";
import type { DatabaseWriterLike, OrderKey } from "./schema-types";
import { ConflictError } from "./transaction";

/** Reserved table the per-shard runner tracks migration progress in. Auto-hidden from the data browser by the `__lunora` prefix. */
const DATA_MIGRATION_STATE_TABLE = "__lunora_migrations";

/** Rows fetched and rewritten per batch when neither the migration nor the caller specifies one. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * A run-state row stuck in `in_progress` is reclaimable once its `updated_at`
 * is older than this. The runner touches `updated_at` after every batch, on
 * claim, AND on a {@link CLAIM_HEARTBEAT_INTERVAL_MS} heartbeat WITHIN a batch,
 * so a healthy run — even one whose single batch runs longer than this timeout —
 * never crosses it; only a runner that crashed or had its DO evicted mid-batch,
 * leaving its claim orphaned, does. Generous enough to absorb a heartbeat
 * interval plus one slow row without letting a deserialized request reclaim a
 * peer that is merely between `await`s; small enough that a genuinely dead
 * runner doesn't wedge the migration for long. 30s mirrors the per-shard
 * fan-out timeout order.
 */
const STALE_CLAIM_TIMEOUT_MS = 30_000;

/**
 * How often, mid-batch, the runner refreshes its claim's `updated_at`. Without
 * this, the only heartbeat during a batch is the claim timestamp, so a single
 * batch (caller-tunable `batchSize` × arbitrary user `transform`) that runs
 * longer than {@link STALE_CLAIM_TIMEOUT_MS} would let a concurrent runner steal
 * the claim and double-process the batch. Heartbeating every 10s keeps a live
 * runner's claim fresh as long as no SINGLE row takes longer than the timeout.
 * Comfortably below the 30s stale window so a heartbeat always lands first.
 */
const CLAIM_HEARTBEAT_INTERVAL_MS = 10_000;

type MigrationDirection = "down" | "up";

type MigrationStatus = "completed" | "failed" | "in_progress";

/** A document handed to a transform: the stored row including `_id`/`_creationTime`. */
type DataMigrationDocument = Record<string, unknown>;

/**
 * The read surface a transform reaches through its `ctx`.
 *
 * Read-only by design: the runner's accounting is "one row rewritten per row
 * read", and a transform that wrote directly would leave that count describing
 * something other than what happened. It is also scoped to THIS shard, which is
 * the honest boundary — a shard-scoped query cannot enumerate rows belonging to
 * another Durable Object.
 */
type DataMigrationReader = Pick<DatabaseWriterLike, "count" | "findFirst" | "findMany" | "get">;

/** The context handed to a transform alongside the row. */
interface DataMigrationContext {
    db: DataMigrationReader;
}

/**
 * Transform applied to one document. Return a new document to rewrite the row,
 * or `undefined` to leave it untouched (counted as processed, not changed). The
 * runner always re-applies the original `_id`/`_creationTime`, so the returned
 * document neither needs to nor should change row identity.
 *
 * The second parameter carries a shard-scoped READER. Without it a transform
 * could only rewrite the row it was handed, which covers a backfill whose new
 * value is a pure function of the old row but not the one people actually write
 * — denormalising a parent's field onto its children, which needs a cross-table
 * read.
 *
 * May return a promise, since a cross-table read is asynchronous.
 */
type DataMigrationTransform = (
    document: DataMigrationDocument,
    context: DataMigrationContext,
) => DataMigrationDocument | Promise<DataMigrationDocument | undefined> | undefined;

/**
 * Structural projection of `@lunora/server`'s `RegisteredMigration` the runner
 * reads. Kept local so this package takes no dependency on `@lunora/server`
 * (which consumes ShardDO types — depending back would cycle).
 */
interface DataMigrationLike {
    readonly batchSize?: number;
    readonly down?: DataMigrationTransform;
    readonly id: string;
    readonly table: string;
    readonly up: DataMigrationTransform;
}

interface RunDataMigrationOptions {
    /** Override the migration's own batch size (and the runner default). */
    batchSize?: number;
    /** Wall clock for `started_at`/`updated_at`; defaults to `Date.now`. */
    clock?: () => number;
    /** Which transform to apply; defaults to `"up"`. */
    direction?: MigrationDirection;
    /** Scan and count without rewriting rows or persisting state. */
    dryRun?: boolean;
    /** Stop after this many batches, leaving the run resumable; defaults to no limit. */
    maxBatches?: number;
    migration: DataMigrationLike;

    /**
     * Called after each non-dry-run batch persists its progress, so a caller
     * (the Durable Object) can flush and let live `migrationStatus` subscribers
     * observe processed/changed counts climb mid-run rather than only at the
     * end. Awaited between batches; a throw aborts the run like any batch error.
     */
    onBatch?: (progress: { batches: number; changed: number; processed: number }) => Promise<void> | void;
    /** Raw SQL handle for the reserved state table (outside the user schema). */
    sql: SqlExec;
    /** Schema-aware writer used to scan and rewrite the user table. */
    writer: DatabaseWriterLike;
}

interface MigrationRunResult {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    dryRun: boolean;
    id: string;
    processed: number;
    status: MigrationStatus;
}

interface PersistedState {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    error: null | string;
    id: string;
    processed: number;
    startedAt: number;
    status: MigrationStatus;
    updatedAt: number;
}

interface ResumeState {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    processed: number;
    startedAt: number | undefined;
    status: MigrationStatus;
}

interface StateRow {
    changed: number;
    cursor: null | string;
    direction: string;
    processed: number;
    started_at: null | number;
    status: string;
}

const ensureStateTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${DATA_MIGRATION_STATE_TABLE}" (
            id TEXT PRIMARY KEY,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            cursor TEXT,
            processed INTEGER NOT NULL DEFAULT 0,
            changed INTEGER NOT NULL DEFAULT 0,
            started_at REAL,
            updated_at REAL,
            error TEXT
        )`,
    );
};

/** Decode the run-state columns shared by {@link readState} and {@link readMigrationStatus}. */
const decodeStateRow = (
    row: StateRow,
): { changed: number; cursor: null | string; direction: MigrationDirection; processed: number; status: MigrationStatus } => {
    return {
        changed: row.changed,
        // eslint-disable-next-line unicorn/no-null -- mirrors the SQLite `cursor` column: a missing cursor is NULL, not undefined
        cursor: typeof row.cursor === "string" ? row.cursor : null,
        direction: row.direction === "down" ? "down" : "up",
        processed: row.processed,
        status: row.status === "completed" || row.status === "failed" ? row.status : "in_progress",
    };
};

/**
 * @returns the persisted migration state for the given id, or `undefined` when no state row exists yet
 */
const readState = (sql: SqlExec, id: string): ResumeState | undefined => {
    const rows = runSql<StateRow>(sql, `SELECT * FROM "${DATA_MIGRATION_STATE_TABLE}" WHERE id = ?`, id).toArray();
    const row = rows[0];

    if (!row) {
        return undefined;
    }

    return {
        ...decodeStateRow(row),
        startedAt: typeof row.started_at === "number" ? row.started_at : undefined,
    };
};

/**
 * Drop the run-state row, but ONLY when no runner is live behind it.
 *
 * The sole caller wipes an opposite-direction row so the new direction starts
 * from a clean cursor. Unconditional, that deletes a *running* peer's claim:
 * `direction` is caller-supplied over the admin RPC (and the CLI exposes
 * `migrate down`), the batch loop awaits per page and per row, so an `up` and a
 * `down` interleave on the same single-threaded DO — the second one erases the
 * first's claim, wins a fresh one, and both then rewrite the same table through
 * `writer.replace`, each overwriting the other's rows.
 *
 * The guard is the same liveness test {@link claimMigration} applies, expressed
 * as one synchronous statement so no peer can observe a half-applied decision:
 * a `completed`/`failed` row, or an `in_progress` one whose `updated_at` predates
 * {@link STALE_CLAIM_TIMEOUT_MS}, is dead and removable; a fresh `in_progress`
 * row is a live runner and survives. When it survives, the claim below fails and
 * the caller returns the active run's state instead of trampling it.
 */
const deleteDeadState = (sql: SqlExec, id: string, staleBefore: number): void => {
    runSql(
        sql,
        `DELETE FROM "${DATA_MIGRATION_STATE_TABLE}"
         WHERE id = ? AND (status <> 'in_progress' OR updated_at IS NULL OR updated_at <= ?)`,
        id,
        staleBefore,
    );
};

/** Upsert the run-state row, preserving `started_at` across resumes by omitting it from the conflict update. */
const persistState = (sql: SqlExec, state: PersistedState): void => {
    runSql(
        sql,
        `INSERT INTO "${DATA_MIGRATION_STATE_TABLE}"
            (id, direction, status, cursor, processed, changed, started_at, updated_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            direction = excluded.direction,
            status = excluded.status,
            cursor = excluded.cursor,
            processed = excluded.processed,
            changed = excluded.changed,
            updated_at = excluded.updated_at,
            error = excluded.error`,
        state.id,
        state.direction,
        state.status,
        state.cursor,
        state.processed,
        state.changed,
        state.startedAt,
        state.updatedAt,
        state.error,
    );
};

/**
 * Atomically claim the `(id, direction)` run so exactly one concurrent runner
 * proceeds. A Durable Object is single-threaded and serializes storage, but two
 * in-flight `runDataMigration` invocations on the same instance interleave at
 * the loop's `await` boundaries: without a claim both would read the same
 * `in_progress` state and reprocess the same batch. This claim is a single
 * synchronous `INSERT … ON CONFLICT` with no `await` inside it, so it runs to
 * completion before any peer can observe a half-updated row — the winner flips
 * `status` to `in_progress` and bumps `updated_at`; every loser sees
 * `changes() === 0`.
 *
 * Claimable when the row is absent, holds a non-`in_progress` status (a
 * `failed` run this runner resumes, or a `completed` one in the opposite
 * direction), OR carries a stale `in_progress` claim whose `updated_at` predates
 * {@link STALE_CLAIM_TIMEOUT_MS} (a crashed runner must not wedge the migration
 * forever). A `completed` row in the SAME direction never reaches here —
 * re-running a finished migration is an idempotent no-op the caller handles
 * before claiming. The `WHERE` therefore rejects exactly one thing: a *fresh*
 * `in_progress` peer.
 *
 * Direction is deliberately NOT part of that test. It used to be — any
 * opposite-direction row counted as claimable, fresh or stale — which made a
 * `down` steal the claim from an `up` that was mid-batch (and vice versa), the
 * one case {@link CLAIM_HEARTBEAT_INTERVAL_MS} exists to make impossible. A live
 * claim is a live claim whichever way it is running.
 */
const claimMigration = (sql: SqlExec, id: string, direction: MigrationDirection, now: number): boolean => {
    runSql(
        sql,
        `INSERT INTO "${DATA_MIGRATION_STATE_TABLE}"
            (id, direction, status, cursor, processed, changed, started_at, updated_at, error)
         VALUES (?, ?, 'in_progress', NULL, 0, 0, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
            status = 'in_progress',
            updated_at = excluded.updated_at
         WHERE
            "${DATA_MIGRATION_STATE_TABLE}".status <> 'in_progress'
            OR "${DATA_MIGRATION_STATE_TABLE}".updated_at IS NULL
            OR "${DATA_MIGRATION_STATE_TABLE}".updated_at <= excluded.updated_at - ${String(STALE_CLAIM_TIMEOUT_MS)}`,
        id,
        direction,
        now,
        now,
    );

    return runSql<{ changed: number }>(sql, `SELECT changes() AS changed`).one().changed > 0;
};

/**
 * Refresh a held claim's `updated_at` mid-batch (the {@link CLAIM_HEARTBEAT_INTERVAL_MS}
 * heartbeat) so a long-running batch never lets the claim look stale to a peer.
 * Guarded on `status = 'in_progress'` so it can only touch a live claim — never
 * a `completed`/`failed` row.
 */
const touchClaim = (sql: SqlExec, id: string, now: number): void => {
    runSql(sql, `UPDATE "${DATA_MIGRATION_STATE_TABLE}" SET updated_at = ? WHERE id = ? AND status = 'in_progress'`, now, id);
};

/**
 * Release this invocation's claim on an incomplete run so a *later* resume can
 * re-claim it without waiting out {@link STALE_CLAIM_TIMEOUT_MS}. Called only on
 * the clean `maxBatches`-bounded return: at that point every `await` has
 * resolved and the runner is genuinely no longer in flight, so there is no live
 * peer to interleave with — the run is paused, not held. We mark it reclaimable
 * by back-dating `updated_at` to the epoch (always older than `now - timeout`),
 * leaving status/cursor/counts intact so the resume picks up exactly where this
 * invocation stopped. A concurrent peer never reaches this path (it loses the
 * claim and returns a no-op before entering the loop), and a crash/throw goes
 * through the `failed` branch instead — so this never widens the race.
 */
const releaseClaim = (sql: SqlExec, id: string): void => {
    runSql(sql, `UPDATE "${DATA_MIGRATION_STATE_TABLE}" SET updated_at = 0 WHERE id = ? AND status = 'in_progress'`, id);
};

/** One persisted run-state row, decoded for callers (admin RPC, CLI status). */
interface MigrationStatusRow {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    error: null | string;
    id: string;
    processed: number;
    startedAt: null | number;
    status: MigrationStatus;
    updatedAt: null | number;
}

interface FullStateRow {
    changed: number;
    cursor: null | string;
    direction: string;
    error: null | string;
    id: string;
    processed: number;
    started_at: null | number;
    status: string;
    updated_at: null | number;
}

/**
 * Read persisted migration run-state: a single row when `id` is given,
 * otherwise every row ordered by id. Returns `[]` when the state table
 * doesn't exist yet (no migration has ever run in this shard) rather than
 * throwing — the data browser and CLI treat "never run" as empty status.
 */
const readMigrationStatus = (sql: SqlExec, id?: string): MigrationStatusRow[] => {
    const exists = runSql<{ name: string }>(
        sql,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        DATA_MIGRATION_STATE_TABLE,
    ).toArray();

    if (exists.length === 0) {
        return [];
    }

    const filter = id === undefined ? " ORDER BY id" : " WHERE id = ?";
    const params = id === undefined ? [] : [id];
    const rows = runSql<FullStateRow>(sql, `SELECT * FROM "${DATA_MIGRATION_STATE_TABLE}"${filter}`, ...params).toArray();

    return rows.map((row) => {
        /* eslint-disable unicorn/no-null -- decoded run-state row: NULL columns surface as null over the admin/CLI wire shape (MigrationStatusRow), distinct from absent */
        return {
            ...decodeStateRow(row),
            error: typeof row.error === "string" ? row.error : null,
            id: row.id,
            startedAt: typeof row.started_at === "number" ? row.started_at : null,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : null,
        };
        /* eslint-enable unicorn/no-null */
    });
};

/**
 * The iteration order `writer.findMany(table, { cursor, limit })` uses when the
 * caller passes no `orderBy` — `normalizeOrderKeys`' default. Named here because
 * the runner mints its own per-row resume cursor from it, and a cursor minted
 * against different keys would seek to the wrong place on resume.
 */
const MIGRATION_ORDER_KEYS: OrderKey[] = [{ direction: "asc", field: "_creationTime", nullable: false }];

/**
 * The cursor prefix this runner's persisted resume points were minted under
 * before {@link CURSOR_PREFIX} was bumped to `"~3"`.
 */
const PRIOR_CURSOR_PREFIX = "~2";

/**
 * Re-stamp a persisted resume cursor that was minted under {@link PRIOR_CURSOR_PREFIX}.
 *
 * The bump exists because a `.withIndex(q => q.eq(f, v)).paginate()` cursor
 * changed payload — `[value, id]` became `[creationTime, id]`, the same length,
 * so nothing downstream could catch it — and `decodeCursor` therefore refuses
 * any older prefix outright. Correct there; fatal here. This runner PERSISTS its
 * cursor, so a resume fed the stored value straight back into `findMany`, threw
 * `invalid cursor`, and re-persisted `failed` with the same doomed cursor: every
 * later run of that migration wedged on it, with no reset short of running the
 * migration backwards (which, for the non-idempotent transforms this runner is
 * built for, is worse than the wedge).
 *
 * Safe HERE and only here, for one reason: this path's key list is
 * {@link MIGRATION_ORDER_KEYS}, a fixed constant that bypasses
 * `normalizeOrderKeys` entirely, so its payload is `[_creationTime, _id]` on
 * BOTH sides of the bump — byte-for-byte valid, stale prefix and all. Nothing
 * general may be inferred from that: making `decodeCursor` itself lenient would
 * restore exactly the silently-wrong page the bump was minted to stop.
 *
 * A FUTURE prefix bump must re-verify this before adding its own predecessor
 * here — if the encoded payload for `[_creationTime, _id]` ever changes, the
 * cursor is not merely mis-prefixed and re-stamping it would seek to the wrong
 * row.
 */
const restampResumeCursor = (cursor: null | string): null | string =>
    typeof cursor === "string" && cursor.startsWith(PRIOR_CURSOR_PREFIX) ? CURSOR_PREFIX + cursor.slice(PRIOR_CURSOR_PREFIX.length) : cursor;

/**
 * How many times one row's transform is re-applied against a fresher read before
 * the run gives up on it. Two is already unusual — it means live traffic wrote
 * the same row twice while this one row was being migrated — so a third failure
 * is a hot row a migration should not be silently losing writes on.
 */
const MAX_ROW_ATTEMPTS = 3;

/**
 * Apply `transform` to one row and rewrite it, re-reading the row between the
 * transform and the write.
 *
 * The rewrite used to run straight off the page document, and that is a lost
 * update: the page was read once, up to `batchSize` `await`s ago, while
 * `writer.replace` compare-and-swaps only on the snapshot it reads at the top of
 * its OWN call. A user mutation landing in that gap was overwritten with the
 * pre-mutation value — no conflict, no error. (The claim machinery around this
 * runner is about two MIGRATION runners interleaving; it says nothing about a
 * migration interleaving with live traffic, which is the normal case.)
 *
 * So the row is re-read after the transform and immediately before the write.
 * Nothing can interleave between them: the continuation that resumes after
 * `get` resolves runs synchronously into `replace`, whose row probe is likewise
 * synchronous. A row that moved is re-transformed against what is actually on
 * disk (rather than skipped, which would silently leave rows unmigrated, or
 * failed, which would let one hot row abort a whole shard's run) — and a row
 * that keeps moving eventually raises, because a transform that can never see a
 * stable row is not something to paper over.
 * @returns whether the row was rewritten (`changed`) or left alone
 */
const applyTransformToRow = async (options: {
    context: DataMigrationContext;
    document: DataMigrationDocument;
    dryRun: boolean;
    table: string;
    transform: DataMigrationTransform;
    writer: DatabaseWriterLike;
}): Promise<"changed" | "unchanged"> => {
    const { context, document, dryRun, table, transform, writer } = options;
    const id = String(document["_id"]);
    let source = document;

    for (let attempt = 0; attempt < MAX_ROW_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- compare-and-swap retry: each attempt transforms what the previous attempt re-read
        const next = await transform(source, context);

        if (next === undefined) {
            return "unchanged";
        }

        if (dryRun) {
            return "changed";
        }

        // Pinned to the migration's own table: a bare `get` probes every table in
        // the schema for the id, which is a per-row O(tables) scan here.
        // eslint-disable-next-line no-await-in-loop -- the re-read must sit between THIS attempt's transform and its write; hoisting it would reopen the gap it closes
        const latest = await writer.get(id, table);

        if (latest === null) {
            // Deleted under us. Rewriting it would resurrect a row the
            // application removed, so leave it: counted processed, not changed.
            return "unchanged";
        }

        if (stableWireKey(latest) === stableWireKey(source)) {
            // Trusted rewrite: preserve the row's original `_creationTime` via
            // the `allowExplicitId` opt-in (default replace mints a fresh clock()).
            // eslint-disable-next-line no-await-in-loop -- writes share one SQLite handle; parallelizing would interleave statements on a single connection.
            await writer.replace(id, { ...next, _creationTime: source["_creationTime"], _id: source["_id"] }, undefined, { allowExplicitId: true });

            return "changed";
        }

        source = latest;
    }

    throw new ConflictError(`data migration could not rewrite row ${id}: it was modified by concurrent traffic on every attempt`, "occ");
};

/**
 * Run one migration over its table within the current shard. Returns the
 * post-run counts and status; `status` is `"in_progress"` only when a
 * `maxBatches` limit cut the run short (it stays resumable).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- the resume/loop/persist phases read more clearly inline than split across helpers that would each need the same closured state
const runDataMigration = async (options: RunDataMigrationOptions): Promise<MigrationRunResult> => {
    const { migration, sql, writer } = options;
    const direction = options.direction ?? "up";
    const dryRun = options.dryRun ?? false;
    const clock = options.clock ?? (() => Date.now());
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const batchSize = options.batchSize ?? migration.batchSize ?? DEFAULT_BATCH_SIZE;

    const transform = direction === "up" ? migration.up : migration.down;

    if (!transform) {
        throw new LunoraError("INTERNAL", `data migration "${migration.id}" has no \`${direction}\` transform`);
    }

    // Only the reads, bound off the same writer the rewrites go through — so a
    // transform sees this shard's live state, including rows this run already
    // rewrote. Handing over the writer itself would let a transform write
    // outside the runner's accounting.
    const migrationContext: DataMigrationContext = {
        db: {
            count: writer.count.bind(writer),
            findFirst: writer.findFirst.bind(writer),
            findMany: writer.findMany.bind(writer),
            get: writer.get.bind(writer),
        },
    };

    // eslint-disable-next-line unicorn/no-null -- keyset cursor: null is the "start of table" sentinel and the value bound to the SQLite cursor column
    let cursor: null | string = null;
    let processed = 0;
    let changed = 0;
    let startedAt = clock();

    if (!dryRun) {
        ensureStateTable(sql);

        const existing = readState(sql, migration.id);

        if (existing?.direction === direction && existing.status === "completed") {
            // Idempotent re-run of a finished migration: a no-op before any
            // claim, so a redundant invocation never touches the row.
            // eslint-disable-next-line unicorn/no-null -- MigrationRunResult.cursor: a completed run reports null (no resume point), matching the wire shape
            return { changed: existing.changed, cursor: null, direction, dryRun, id: migration.id, processed: existing.processed, status: "completed" };
        }

        if (existing && existing.direction !== direction) {
            // Opposite direction — discard the prior run's progress so this one
            // starts fresh (and `started_at` resets on the claim INSERT). Done
            // synchronously, immediately before the claim, so no peer slips in.
            // Gated on liveness: a peer still heartbeating its claim keeps its
            // row, the claim below then fails, and we return its state rather
            // than running a second rewrite of the same table alongside it.
            deleteDeadState(sql, migration.id, clock() - STALE_CLAIM_TIMEOUT_MS);
        }

        // Atomic in-flight guard. Exactly one of two interleaved invocations on
        // this single-threaded DO wins the claim (flips status to in_progress +
        // touches updated_at in one synchronous statement); the loser sees
        // `changes() === 0` and returns the active run's state without entering
        // the batch loop, so the table is migrated ONCE. A stale in_progress
        // claim (a crashed/evicted runner, updated_at older than the timeout) is
        // reclaimable here too.
        const claimed = claimMigration(sql, migration.id, direction, clock());

        if (!claimed) {
            const active = readState(sql, migration.id);

            return {
                changed: active?.changed ?? 0,
                cursor: active?.cursor ?? cursor,
                // The holder's direction, not the requested one: a `down` that
                // loses to a live `up` must not report itself as the in-progress
                // run. Identical to `direction` for the same-direction loser.
                direction: active?.direction ?? direction,
                dryRun,
                id: migration.id,
                processed: active?.processed ?? 0,
                status: active?.status ?? "in_progress",
            };
        }

        // We hold the claim — resume from our own persisted progress (the claim
        // preserved cursor/counts for a same-direction resumable row).
        const resume = existing?.direction === direction ? existing : undefined;

        if (resume) {
            cursor = restampResumeCursor(resume.cursor);
            processed = resume.processed;
            changed = resume.changed;
            startedAt = resume.startedAt ?? startedAt;
        }
    }

    let isDone = false;
    let batches = 0;
    // Last time we refreshed the claim's `updated_at`. Seeded at the claim time
    // so the first heartbeat lands one interval into a long batch.
    let lastHeartbeatAt = startedAt;

    try {
        while (!isDone && batches < maxBatches) {
            // eslint-disable-next-line no-await-in-loop -- batches must run sequentially: each page's cursor depends on the prior page, and all rewrites share one SQLite handle.
            const batch = await writer.findMany(migration.table, { cursor, limit: batchSize });

            for (const document of batch.page) {
                // eslint-disable-next-line no-await-in-loop -- rows share one SQLite handle; a transform's cross-table read must complete before the next row's rewrite
                const outcome = await applyTransformToRow({ context: migrationContext, document, dryRun, table: migration.table, transform, writer });

                if (outcome === "changed") {
                    changed += 1;
                }

                // Counted and cursor-advanced only once the row is fully handled.
                // Both used to move BEFORE the transform / at the end of the batch,
                // so a mid-batch throw persisted the page-start cursor with the
                // failed row already counted: the resume re-walked rows it had
                // already rewritten (bumping a `version + 1` transform twice) and
                // re-counted them.
                processed += 1;
                cursor = encodeCursor(document, MIGRATION_ORDER_KEYS);

                // Mid-batch heartbeat: keep the claim fresh so a batch that runs
                // longer than the stale-claim window can't be reclaimed out from
                // under this live runner. Cheap, in-DO write; only when we hold a
                // claim (non-dry-run) and an interval has elapsed.
                if (!dryRun) {
                    const now = clock();

                    if (now - lastHeartbeatAt >= CLAIM_HEARTBEAT_INTERVAL_MS) {
                        touchClaim(sql, migration.id, now);
                        lastHeartbeatAt = now;
                    }
                }
            }

            cursor = batch.continueCursor;
            isDone = batch.isDone;
            batches += 1;

            if (!dryRun) {
                const batchEndedAt = clock();

                persistState(sql, {
                    changed,
                    // eslint-disable-next-line unicorn/no-null -- bound to the SQLite cursor column: a finished run stores NULL
                    cursor: isDone ? null : cursor,
                    direction,
                    // eslint-disable-next-line unicorn/no-null -- bound to the SQLite error column: a clean batch stores NULL
                    error: null,
                    id: migration.id,
                    processed,
                    startedAt,
                    status: isDone ? "completed" : "in_progress",
                    updatedAt: batchEndedAt,
                });

                // The end-of-batch persist already refreshed `updated_at`, so the
                // next batch's heartbeat interval starts from here.
                lastHeartbeatAt = batchEndedAt;

                // Progress notification is best-effort: the batch's rows are
                // already persisted, so a flush/push failure must neither abort
                // the run nor (on the final batch) flip a completed migration to
                // failed via the catch below. Swallow it.
                try {
                    // eslint-disable-next-line no-await-in-loop -- progress is reported in batch order; the callback flushes the DO between sequential batches.
                    await options.onBatch?.({ batches, changed, processed });
                } catch {
                    /* progress flush failed — ignore, the run itself is unaffected */
                }
            }
        }
    } catch (error) {
        if (!dryRun) {
            persistState(sql, {
                changed,
                cursor,
                direction,
                error: error instanceof Error ? error.message : String(error),
                id: migration.id,
                processed,
                startedAt,
                status: "failed",
                updatedAt: clock(),
            });
        }

        throw error;
    }

    if (!dryRun && !isDone) {
        // Paused on the `maxBatches` limit, not finished. Drop our claim so the
        // next invocation can resume immediately rather than waiting out the
        // stale-claim timeout (see releaseClaim). A failure here is non-fatal:
        // the batch succeeded, and the stale-claim timeout still lets a later
        // invocation reclaim after STALE_CLAIM_TIMEOUT_MS.
        try {
            releaseClaim(sql, migration.id);
        } catch (error) {
            // Claim release is best-effort; the stale-claim timeout is the fallback. Log so
            // repeated failures are observable rather than silently delaying every resume.
            // eslint-disable-next-line no-console -- no logger is injected here; emit via console so the host captures the swallowed release failure
            console.warn(`data migration "${migration.id}": releaseClaim failed`, error);
        }
    }

    // eslint-disable-next-line unicorn/no-null -- MigrationRunResult.cursor: null on completion (no resume point), matching the wire shape
    return { changed, cursor: isDone ? null : cursor, direction, dryRun, id: migration.id, processed, status: isDone ? "completed" : "in_progress" };
};

export { DATA_MIGRATION_STATE_TABLE, readMigrationStatus, runDataMigration };
export type {
    DataMigrationContext,
    DataMigrationDocument,
    DataMigrationLike,
    DataMigrationReader,
    DataMigrationTransform,
    MigrationDirection,
    MigrationRunResult,
    MigrationStatus,
    MigrationStatusRow,
    RunDataMigrationOptions,
};
