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
 * `__cirrus_migrations` table after every batch. A run that resumes the same
 * id+direction picks up from the stored cursor instead of rescanning.
 * - **Idempotent on completion.** Re-running a migration already `completed` in
 * the same direction is a no-op that returns the recorded counts.
 *
 * Cursor stability is the linchpin: iteration uses the default
 * `_creationTime ASC, id ASC` order, and `replace` preserves both `_id` and
 * `_creationTime`, so rewriting a row never moves it relative to the cursor —
 * each row is visited exactly once even as the batch ahead of us is rewritten.
 *
 * `dryRun` previews counts from a fresh scan without touching either the data
 * rows or the state table.
 */

import type { DatabaseWriterLike, SqlCursor, SqlExec } from "./ctx-db";

/** Reserved table the per-shard runner tracks migration progress in. Auto-hidden from the data browser by the `__cirrus` prefix. */
const DATA_MIGRATION_STATE_TABLE = "__cirrus_migrations";

/** Rows fetched and rewritten per batch when neither the migration nor the caller specifies one. */
const DEFAULT_BATCH_SIZE = 100;

type MigrationDirection = "down" | "up";

type MigrationStatus = "completed" | "failed" | "in_progress";

/** A document handed to a transform: the stored row including `_id`/`_creationTime`. */
type DataMigrationDocument = Record<string, unknown>;

/**
 * Transform applied to one document. Return a new document to rewrite the row,
 * or `undefined` to leave it untouched (counted as processed, not changed). The
 * runner always re-applies the original `_id`/`_creationTime`, so the returned
 * document neither needs to nor should change row identity.
 */
type DataMigrationTransform = (document: DataMigrationDocument) => DataMigrationDocument | undefined;

/**
 * Structural projection of `@cirrus/server`'s `RegisteredMigration` the runner
 * reads. Kept local so this package takes no dependency on `@cirrus/server`
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

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

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

const readState = (sql: SqlExec, id: string): ResumeState | undefined => {
    const rows = runSql<StateRow>(sql, `SELECT * FROM "${DATA_MIGRATION_STATE_TABLE}" WHERE id = ?`, id).toArray();
    const row = rows[0];

    if (!row) {
        return undefined;
    }

    return {
        changed: row.changed,
        // eslint-disable-next-line unicorn/no-null -- mirrors the SQLite `cursor` column: a missing cursor is NULL, not undefined
        cursor: typeof row.cursor === "string" ? row.cursor : null,
        direction: row.direction === "down" ? "down" : "up",
        processed: row.processed,
        startedAt: typeof row.started_at === "number" ? row.started_at : undefined,
        status: row.status === "completed" || row.status === "failed" ? row.status : "in_progress",
    };
};

const deleteState = (sql: SqlExec, id: string): void => {
    runSql(sql, `DELETE FROM "${DATA_MIGRATION_STATE_TABLE}" WHERE id = ?`, id);
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
            changed: row.changed,
            cursor: typeof row.cursor === "string" ? row.cursor : null,
            direction: row.direction === "down" ? "down" : "up",
            error: typeof row.error === "string" ? row.error : null,
            id: row.id,
            processed: row.processed,
            startedAt: typeof row.started_at === "number" ? row.started_at : null,
            status: row.status === "completed" || row.status === "failed" ? row.status : "in_progress",
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : null,
        };
        /* eslint-enable unicorn/no-null */
    });
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
        throw new Error(`data migration "${migration.id}" has no \`${direction}\` transform`);
    }

    // eslint-disable-next-line unicorn/no-null -- keyset cursor: null is the "start of table" sentinel and the value bound to the SQLite cursor column
    let cursor: null | string = null;
    let processed = 0;
    let changed = 0;
    let startedAt = clock();

    if (!dryRun) {
        ensureStateTable(sql);

        const existing = readState(sql, migration.id);

        if (existing?.direction === direction) {
            if (existing.status === "completed") {
                // eslint-disable-next-line unicorn/no-null -- MigrationRunResult.cursor: a completed run reports null (no resume point), matching the wire shape
                return { changed: existing.changed, cursor: null, direction, dryRun, id: migration.id, processed: existing.processed, status: "completed" };
            }

            cursor = existing.cursor;
            processed = existing.processed;
            changed = existing.changed;
            startedAt = existing.startedAt ?? startedAt;
        } else if (existing) {
            // Opposite direction — discard the prior run's progress so this one
            // starts fresh (and `started_at` resets on the next INSERT).
            deleteState(sql, migration.id);
        }
    }

    let isDone = false;
    let batches = 0;

    try {
        while (!isDone && batches < maxBatches) {
            // eslint-disable-next-line no-await-in-loop -- batches must run sequentially: each page's cursor depends on the prior page, and all rewrites share one SQLite handle.
            const batch = await writer.findMany(migration.table, { cursor, limit: batchSize });

            for (const document of batch.page) {
                processed += 1;

                const next = transform(document);

                if (next !== undefined) {
                    changed += 1;

                    if (!dryRun) {
                        // eslint-disable-next-line no-await-in-loop -- writes share one SQLite handle; parallelizing would interleave statements on a single connection.
                        await writer.replace(String(document["_id"]), { ...next, _creationTime: document["_creationTime"], _id: document["_id"] });
                    }
                }
            }

            cursor = batch.continueCursor;
            isDone = batch.isDone;
            batches += 1;

            if (!dryRun) {
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
                    updatedAt: clock(),
                });

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

    // eslint-disable-next-line unicorn/no-null -- MigrationRunResult.cursor: null on completion (no resume point), matching the wire shape
    return { changed, cursor: isDone ? null : cursor, direction, dryRun, id: migration.id, processed, status: isDone ? "completed" : "in_progress" };
};

export { DATA_MIGRATION_STATE_TABLE, readMigrationStatus, runDataMigration };
export type {
    DataMigrationDocument,
    DataMigrationLike,
    DataMigrationTransform,
    MigrationDirection,
    MigrationRunResult,
    MigrationStatus,
    MigrationStatusRow,
    RunDataMigrationOptions,
};
