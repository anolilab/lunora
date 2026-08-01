/**
 * Per-shard durable function-call metrics.
 *
 * A reserved table that accumulates per-`&lt;file>:&lt;function>` call counters and
 * latency aggregates so they survive DO hibernation/restart — the in-memory
 * `metrics`/`functionStats` on `ShardDO` reset on every cold start, which is
 * fine for a "since this instance woke" readout but loses the lifetime picture
 * an operator wants. This table is the durable source of truth the
 * `__lunora_admin__:getFunctionStats` / `getMetrics` RPCs read from.
 *
 * Modelled on the reserved-table helpers in `audit-log.ts`
 * (`ensureAuditTable`/`appendAuditEntry`/`readAuditLog`) and the CDC-log helpers
 * in `ctx-db.ts`. Four reserved tables back this feature.
 *
 * `__lunora_metrics` holds one row per function path with the lifetime
 * accumulators (calls, errors, summed/min/max latency, last-called/last-error
 * timestamps). A function call is a single cheap `INSERT … ON CONFLICT … DO
 * UPDATE` upsert against this row, on the hot path.
 *
 * `__lunora_metrics_buckets` holds coarse time-bucketed counters
 * (`path` × `bucketMs`) giving a basic per-function time series the studio
 * can chart. Bucketing the timestamp to a fixed window keeps the row count
 * bounded (one row per function per window) while still surviving restart.
 *
 * `__lunora_metrics_scans` holds the causal full-scan attribution
 * (`path` × `table`): how many times the function full-scanned each table (a
 * read with no index / point lookup, stamped via `SCAN_DEP` in `ctx-db.ts`).
 * This is the raw signal behind the Insights "missing index" / "full scan"
 * reads — it lets the studio say "`feed:list` is slow BECAUSE it
 * full-scanned `posts`" rather than flagging the slow function as an isolated
 * symptom. Keyed by `(path, table)` so the row count is bounded by the
 * (functions × tables) the app actually scans. The `__lunora_metrics` row also
 * carries an aggregate `scans` counter so a function's total scan volume is a
 * single-row read.
 *
 * `__lunora_metrics_index` holds the per-`(table, index)` hit counter: how many
 * recorded reads USED each declared index to narrow (the complement of the
 * scans table, stamped via `onIndexUse` in `ctx-db.ts`). It's the durable
 * producer behind the advisor `index_utilization` dead-index lint — a declared
 * index with zero recorded reads is dead overhead. The counter is cumulative and
 * never decays (unlike the time-bucketed buckets table), so a non-zero count
 * never reverts to dead. Keyed by `(table_name, index_name)` so the row count is
 * bounded by the indexes the app actually exercises; the lint reconciles this
 * against the declared schema to
 * find indexes that recorded nothing. Unlike the scans table this is keyed on
 * the index, not the function, since the dead-index signal is per-index across
 * the whole workload.
 *
 * All four tables carry the reserved `__lunora` prefix, so the data browser
 * hides them automatically.
 */

import type { FunctionCallStat, FunctionScanAttribution, SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Reserved per-function accumulator table. Auto-hidden from the data browser by the `__lunora` prefix. */
const FUNCTION_METRICS_TABLE = "__lunora_metrics";

/** Reserved coarse time-series table: per-function call/error counts bucketed by a fixed window. */
const FUNCTION_METRICS_BUCKETS_TABLE = "__lunora_metrics_buckets";

/** Reserved causal full-scan attribution table: per-(function, table) full-scan counts. */
const FUNCTION_METRICS_SCANS_TABLE = "__lunora_metrics_scans";

/** Reserved per-(table, index) hit-counter table backing the advisor dead-index lint. */
const FUNCTION_METRICS_INDEX_TABLE = "__lunora_metrics_index";

/**
 * Width of one history bucket, in milliseconds. 60s gives a minute-resolution
 * time series — fine-grained enough to chart bursts on the studio, coarse
 * enough that a single function emits at most one row per minute. Exported so
 * consumers (and tests) can align timestamps to the same grid.
 */
const FUNCTION_METRICS_BUCKET_MS = 60_000;

/**
 * Most recent buckets kept per function; older rows are trimmed after each
 * write so the time series can't grow unbounded. 1440 minute-buckets ≈ 24h of
 * history per function.
 */
const FUNCTION_METRICS_BUCKET_RETENTION = 1440;

/**
 * Maximum distinct function `path`s tracked in the accumulator table. Mirrors
 * `query-metrics.ts`'s `QUERY_METRICS_MAX_STATEMENTS` cap (and exists for the
 * same reason): the real bound is the app's own registered-function set plus
 * deploy churn (a rename/removal leaves its old path's row in place until the
 * cap evicts it) — a few thousand registered functions is already far beyond
 * any real app. `shard-do.ts`'s dispatch handler explicitly does NOT record
 * per-function metrics for an unregistered/`FUNCTION_NOT_FOUND` dispatch (see
 * the guard next to its `FUNCTION_NOT_FOUND` check), so a caller cannot mint
 * arbitrary `path`s here the way a raw caller-supplied SQL shape can in
 * `query-metrics.ts`. Without a cap, deploy churn across the app's lifetime
 * would still grow `__lunora_metrics` (and its bucket/scan satellites) without
 * bound, eventually filling the shard's SQLite store shared with the app's
 * real data. At the cap, the accumulator row with the oldest `last_called_at`
 * is evicted (along with its bucket/scan satellite rows) to admit a
 * genuinely new path; already-tracked paths keep accumulating past the cap.
 */
const FUNCTION_METRICS_MAX_PATHS = 5000;

/**
 * Upper bound on rows the admin reads materialize into DO memory at once. Even
 * with the write-side `FUNCTION_METRICS_MAX_PATHS` cap in place, an existing
 * shard could already hold a bloated accumulator (rows written before the cap
 * landed), so the read path also clamps — a `SELECT *` with no LIMIT would
 * otherwise load every row via `.toArray()` and risk OOMing the ~128MB DO when
 * the studio Function Stats panel opens. Ordered reads keep the busiest/most
 * recent rows; the tail past this limit is simply not returned to the panel.
 */
const FUNCTION_METRICS_READ_LIMIT = 1000;

/** One coarse time-series sample for a function: call/error counts within `[bucketMs, bucketMs + FUNCTION_METRICS_BUCKET_MS)`. */
interface FunctionMetricBucket {
    /** Epoch-ms floor of the bucket window. */
    bucketMs: number;
    /** Dispatches recorded in this window. */
    calls: number;
    /** Subset of `calls` that threw. */
    errors: number;
}

/** {@link readFunctionMetricBuckets} result: the time-series window plus whether the read limit cut it short. */
interface FunctionMetricBucketsResult {
    buckets: (FunctionMetricBucket & { path: string })[];

    /**
     * True when more rows existed than {@link FUNCTION_METRICS_READ_LIMIT} could
     * return, so `buckets` is a partial (newest) window rather than the app's
     * full retained history. Mirrors `readQueryInsights`'s `capped` and
     * `foldTraces`'s `total`: a silently truncated read looks identical to a
     * complete one to a caller that doesn't check for it — the Metrics chart's
     * window would appear to shrink as the app grows, with a wrong leftmost
     * bar, and nothing would say why.
     */
    truncated: boolean;
}

/** One declared index a dispatch exercised (used to narrow a read). */
interface IndexHit {
    /** The declared index name. */
    index: string;
    /** The table the index is declared on. */
    table: string;
}

/** One declared index's cumulative recorded read count (durable, non-decaying) — the advisor dead-index lint input. */
interface FunctionMetricIndexHit {
    /** The declared index name. */
    index: string;
    /** Recorded reads that used this index to narrow. */
    reads: number;
    /** The table the index is declared on. */
    table: string;
}

/** Fields recorded for one completed dispatch. `errored` advances the failure counters. */
interface RecordFunctionMetricInput {
    /**
     * Whether the dispatch failed on an optimistic-concurrency (OCC) write
     * conflict — a compare-and-swap that lost to a concurrent commit. Advances
     * the durable `conflicts` counter behind the write-contention advisor. A
     * conflicted dispatch also `errored`, so conflicts are a subset of errors.
     * Omitted/false on the common path, keeping the hot path unchanged.
     */
    conflicted?: boolean;
    /** Wall-clock millis the handler took. */
    durationMs: number;
    /** Whether the dispatch threw. */
    errored: boolean;
    /** Most recent failure message, recorded only when `errored`. */
    errorMessage?: string;

    /**
     * Distinct declared indexes this dispatch exercised (used to narrow a read),
     * collected from the `onIndexUse` signal. Each entry bumps the
     * per-`(table, index)` hit counter in `__lunora_metrics_index`, the durable
     * producer behind the advisor dead-index lint. Omitted/empty when the
     * dispatch used no declared index, keeping the hot path unchanged.
     */
    indexHits?: ReadonlyArray<IndexHit>;
    /** The `&lt;file>:&lt;function>` identifier. */
    path: string;

    /**
     * Distinct tables this dispatch full-scanned (read with no index / point
     * lookup), collected from the `SCAN_DEP` reads. Each entry bumps the
     * aggregate `scans` counter and the per-`(path, table)` attribution row.
     * Omitted/empty when the dispatch didn't full-scan anything (the common
     * indexed case), keeping the hot path to the same two upserts as before.
     */
    scannedTables?: ReadonlyArray<string>;
    /** Epoch-ms the dispatch completed. */
    ts: number;
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** Floor `ts` to the start of its history bucket. */
const bucketFloor = (ts: number): number => Math.floor(ts / FUNCTION_METRICS_BUCKET_MS) * FUNCTION_METRICS_BUCKET_MS;

/** Collapse a dispatch's index hits to one entry per distinct `(table, index)` so each counts as one read. */
const dedupeIndexHits = (hits: ReadonlyArray<IndexHit>): IndexHit[] => {
    const seen = new Map<string, IndexHit>();

    for (const hit of hits) {
        seen.set(`${hit.table}\u0000${hit.index}`, { index: hit.index, table: hit.table });
    }

    return [...seen.values()];
};

/**
 * SQL handles whose four reserved tables (and, for `__lunora_metrics`, its
 * back-filled columns) have already been ensured this instance. Every read
 * and write path calls {@link ensureFunctionMetricsTables} defensively, and
 * `recordFunctionMetric` runs once per RPC dispatch — without memoizing,
 * every dispatch re-ran `CREATE TABLE IF NOT EXISTS` four times plus the two
 * back-fill `ALTER TABLE`s below, and the `ALTER`s throw `duplicate column
 * name` on every call after the first (a column that already exists cannot be
 * re-added), so two SQLite errors were being constructed and swallowed per
 * dispatch forever. Memoizing per handle drops all of that off the hot path
 * after the first call. A `WeakSet` so a torn-down shard's handle is
 * collectable; a fresh handle (a new isolate after hibernation) re-ensures,
 * which is correct — mirrors `metric-history.ts`'s `ensuredHandles`.
 */
const ensuredHandles = new WeakSet<SqlExec>();

/**
 * Create the four reserved metrics tables. Idempotent, so the read and write
 * paths can call it defensively. The accumulator table is keyed by `path` (one
 * row per function); the bucket table by `(path, bucketMs)` (one row per
 * function per window); the scans table by `(path, table)` (one row per
 * function per full-scanned table); the index table by `(table, index)` (one
 * row per declared index the app exercises).
 *
 * The accumulator's `scans` column is added via a guarded `ALTER TABLE` rather
 * than baked into the `CREATE` so a shard whose `__lunora_metrics` predates the
 * causal-attribution feature gains the column on the next call without a
 * migration. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the duplicate-column
 * error from a re-run is swallowed. Both the `CREATE`s and the back-fill only
 * run once per handle (see {@link ensuredHandles}) — a handle already marked
 * ensured returns immediately.
 */
const ensureFunctionMetricsTables = (sql: SqlExec): void => {
    if (ensuredHandles.has(sql)) {
        return;
    }

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${FUNCTION_METRICS_TABLE}" (
            path TEXT PRIMARY KEY,
            calls INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            conflicts INTEGER NOT NULL DEFAULT 0,
            scans INTEGER NOT NULL DEFAULT 0,
            total_duration_ms REAL NOT NULL DEFAULT 0,
            min_duration_ms REAL,
            max_duration_ms REAL NOT NULL DEFAULT 0,
            last_called_at REAL NOT NULL DEFAULT 0,
            last_error_at REAL,
            last_error_message TEXT
        )`,
    );

    // Back-fill columns added after the original `__lunora_metrics` shape, for
    // shards created before each feature landed. SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so the duplicate-column error from a re-run
    // (or the freshly-created schema above) is swallowed per column.
    for (const column of ["scans", "conflicts"]) {
        try {
            runSql(sql, `ALTER TABLE "${FUNCTION_METRICS_TABLE}" ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
        } catch {
            // Column already exists — no-op.
        }
    }

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${FUNCTION_METRICS_BUCKETS_TABLE}" (
            path TEXT NOT NULL,
            bucket_ms INTEGER NOT NULL,
            calls INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (path, bucket_ms)
        )`,
    );

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${FUNCTION_METRICS_SCANS_TABLE}" (
            path TEXT NOT NULL,
            table_name TEXT NOT NULL,
            scans INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (path, table_name)
        )`,
    );

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${FUNCTION_METRICS_INDEX_TABLE}" (
            table_name TEXT NOT NULL,
            index_name TEXT NOT NULL,
            reads INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (table_name, index_name)
        )`,
    );

    ensuredHandles.add(sql);
};

/**
 * Paths this handle has confirmed are already tracked in the accumulator
 * table — once a path is in here, {@link admitPath} skips the cap check
 * entirely on every later dispatch for it. Bounded implicitly by
 * {@link FUNCTION_METRICS_MAX_PATHS}: a path is only ever added once it's
 * confirmed tracked (admitted-under-the-cap or found already present), and a
 * rejected path is never added, so this can't grow past the cap itself. A
 * `WeakMap` so a torn-down shard's handle is collectable; a fresh handle (a
 * new isolate after hibernation) starts cold and re-verifies.
 */
const knownPaths = new WeakMap<SqlExec, Set<string>>();

const knownPathsFor = (sql: SqlExec): Set<string> => {
    let set = knownPaths.get(sql);

    if (set === undefined) {
        set = new Set<string>();
        knownPaths.set(sql, set);
    }

    return set;
};

/**
 * Admit `path` against the distinct-path cap without an unconditional
 * `SELECT COUNT(*)` on every dispatch. Mirrors `metric-history.ts`'s
 * series-cap check. A path this handle has already confirmed tracked
 * ({@link knownPaths}) is admitted with no SQL at all — the steady-path case
 * once every registered function has been seen once. A first-sight path pays
 * one indexed PK lookup to tell "already tracked" (admitted, no count needed
 * — an existing path always keeps accumulating past the cap) from "genuinely
 * new to this shard". Only a genuinely new path reaches the actual
 * `COUNT(*)` gate, which is the rare case after warm-up (a few thousand
 * registered functions is already far beyond any real app). This is what
 * keeps the cap honest: a cache that instead guessed at the row count
 * without re-verifying a first-sight path against the table would let a
 * steady trickle of new paths slip past the limit indefinitely.
 */
const admitPath = (sql: SqlExec, path: string): boolean => {
    const known = knownPathsFor(sql);

    if (known.has(path)) {
        return true;
    }

    const alreadyTracked = runSql<{ c: number }>(sql, `SELECT 1 AS c FROM "${FUNCTION_METRICS_TABLE}" WHERE path = ? LIMIT 1`, path).toArray().length > 0;

    if (alreadyTracked) {
        known.add(path);

        return true;
    }

    const pathCountRow = runSql<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM "${FUNCTION_METRICS_TABLE}"`).one();

    if (pathCountRow.n >= FUNCTION_METRICS_MAX_PATHS) {
        // At capacity: evict the coldest path (smallest `last_called_at`) to
        // admit this genuinely new one, mirroring `metric-history.ts`'s
        // series-cap eviction and `MetricBuffer.push`'s in-memory LRU policy.
        // Without this, a deploy that renames/removes functions would
        // permanently fill the accumulator with dead paths and refuse every
        // path introduced afterward — including the app's own new functions.
        const evictRow = runSql<{ path: string }>(sql, `SELECT path FROM "${FUNCTION_METRICS_TABLE}" ORDER BY last_called_at ASC LIMIT 1`).toArray()[0];

        if (evictRow === undefined) {
            return false;
        }

        runSql(sql, `DELETE FROM "${FUNCTION_METRICS_TABLE}" WHERE path = ?`, evictRow.path);
        runSql(sql, `DELETE FROM "${FUNCTION_METRICS_BUCKETS_TABLE}" WHERE path = ?`, evictRow.path);
        runSql(sql, `DELETE FROM "${FUNCTION_METRICS_SCANS_TABLE}" WHERE path = ?`, evictRow.path);
        known.delete(evictRow.path);
    }

    known.add(path);

    return true;
};

/**
 * Persist one completed dispatch: a single upsert into the accumulator row and
 * one upsert into the current time bucket, then a bounded trim of old buckets
 * for that path. Creates the tables first so callers needn't. This is the hot
 * path — exactly two `INSERT … ON CONFLICT … DO UPDATE` statements plus a
 * bounded `DELETE`, all keyed by primary key, so it stays cheap.
 *
 * When the dispatch full-scanned one or more tables (`scannedTables`), the
 * aggregate `scans` counter on the accumulator row advances by the distinct
 * table count and one extra `(path, table)` upsert fires per scanned table.
 * Indexed dispatches (the common case) skip all of that and pay nothing.
 */
const recordFunctionMetric = (sql: SqlExec, input: RecordFunctionMetricInput): void => {
    ensureFunctionMetricsTables(sql);

    // Distinct-path cap (mirrors `query-metrics.ts`): when the accumulator is at
    // the limit and this `path` isn't tracked yet, skip the write entirely so a
    // flood of unregistered/random paths can't grow the metrics tables without
    // bound. An already-tracked path (the normal registered-function case)
    // still records past the cap. See `admitPath` for how this avoids the
    // unconditional `COUNT(*)` the old version paid on every single dispatch.
    if (!admitPath(sql, input.path)) {
        return;
    }

    // Dedupe defensively: a handler can stamp the same table's SCAN_DEP more
    // than once in a request, but we attribute one scan per distinct table.
    const scannedTables = input.scannedTables ? [...new Set(input.scannedTables)] : [];
    const scanCount = scannedTables.length;
    // Same dedupe for index hits: one read per distinct `(table, index)` per
    // dispatch, regardless of how many rows it narrowed.
    const indexHits = dedupeIndexHits(input.indexHits ?? []);
    const errorCount = input.errored ? 1 : 0;
    const conflictCount = input.conflicted ? 1 : 0;
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for "no failure yet"; coalesced into the row on the first throw.
    const lastErrorAt = input.errored ? input.ts : null;
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for "no failure yet".
    const lastErrorMessage = input.errored ? (input.errorMessage ?? null) : null;

    // Accumulator upsert. On conflict we fold the new sample in: counts add,
    // total latency adds, min/max collapse via MIN/MAX, last-called advances,
    // and the last-error fields only update when this dispatch threw (so a
    // later success never clears the most recent error).
    runSql(
        sql,
        `INSERT INTO "${FUNCTION_METRICS_TABLE}"
            (path, calls, errors, conflicts, scans, total_duration_ms, min_duration_ms, max_duration_ms, last_called_at, last_error_at, last_error_message)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
            calls = calls + 1,
            errors = errors + excluded.errors,
            conflicts = conflicts + excluded.conflicts,
            scans = scans + excluded.scans,
            total_duration_ms = total_duration_ms + excluded.total_duration_ms,
            min_duration_ms = MIN(COALESCE(min_duration_ms, excluded.min_duration_ms), excluded.min_duration_ms),
            max_duration_ms = MAX(max_duration_ms, excluded.max_duration_ms),
            last_called_at = excluded.last_called_at,
            last_error_at = CASE WHEN excluded.last_error_at IS NULL THEN last_error_at ELSE excluded.last_error_at END,
            last_error_message = CASE WHEN excluded.last_error_at IS NULL THEN last_error_message ELSE excluded.last_error_message END`,
        input.path,
        errorCount,
        conflictCount,
        scanCount,
        input.durationMs,
        input.durationMs,
        input.durationMs,
        input.ts,
        lastErrorAt,
        lastErrorMessage,
    );

    // Time-bucket upsert: bump the call/error counts for this function's
    // current minute window.
    const bucket = bucketFloor(input.ts);

    runSql(
        sql,
        `INSERT INTO "${FUNCTION_METRICS_BUCKETS_TABLE}" (path, bucket_ms, calls, errors)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(path, bucket_ms) DO UPDATE SET
            calls = calls + 1,
            errors = errors + excluded.errors`,
        input.path,
        bucket,
        errorCount,
    );

    // Bounded retention: keep only the most recent buckets for this path.
    runSql(
        sql,
        `DELETE FROM "${FUNCTION_METRICS_BUCKETS_TABLE}"
         WHERE path = ?
           AND bucket_ms <= (
            SELECT MAX(bucket_ms) - ? FROM "${FUNCTION_METRICS_BUCKETS_TABLE}" WHERE path = ?
           )`,
        input.path,
        FUNCTION_METRICS_BUCKET_RETENTION * FUNCTION_METRICS_BUCKET_MS,
        input.path,
    );

    // Causal attribution: one PK-keyed upsert per distinct full-scanned table.
    // Skipped entirely for the common indexed dispatch (empty `scannedTables`),
    // so the hot path stays at the two upserts + trim above unless a scan fired.
    for (const table of scannedTables) {
        runSql(
            sql,
            `INSERT INTO "${FUNCTION_METRICS_SCANS_TABLE}" (path, table_name, scans)
             VALUES (?, ?, 1)
             ON CONFLICT(path, table_name) DO UPDATE SET
                scans = scans + 1`,
            input.path,
            table,
        );
    }

    // Index-hit attribution: one PK-keyed upsert per distinct `(table, index)`
    // the dispatch exercised — the durable producer for the dead-index lint.
    // Skipped when the dispatch used no declared index.
    for (const hit of indexHits) {
        runSql(
            sql,
            `INSERT INTO "${FUNCTION_METRICS_INDEX_TABLE}" (table_name, index_name, reads)
             VALUES (?, ?, 1)
             ON CONFLICT(table_name, index_name) DO UPDATE SET
                reads = reads + 1`,
            hit.table,
            hit.index,
        );
    }
};

/**
 * Read the per-function full-scan attribution, grouped by function path. The
 * returned map keys are `path`; each value is the function's full-scanned
 * tables ordered by scan count (busiest scan first), so the causal "slow
 * BECAUSE it scanned X" read can lead with the dominant table. Creates the
 * table first so reads on a never-called shard return an empty map.
 */
const readFunctionMetricScans = (sql: SqlExec): Map<string, FunctionScanAttribution[]> => {
    ensureFunctionMetricsTables(sql);

    const rows = runSql<{ path: string; scans: number; table_name: string }>(
        sql,
        // Bounded read: cap the materialized rows so a bloated attribution table
        // can't blow up DO memory. Highest-scan rows lead so the dominant
        // attributions survive the cut.
        `SELECT path, table_name, scans FROM "${FUNCTION_METRICS_SCANS_TABLE}" ORDER BY scans DESC, path ASC, table_name ASC LIMIT ${String(FUNCTION_METRICS_READ_LIMIT)}`,
    ).toArray();

    const byPath = new Map<string, FunctionScanAttribution[]>();

    for (const row of rows) {
        const list = byPath.get(row.path);
        const entry: FunctionScanAttribution = { scans: row.scans, table: row.table_name };

        if (list === undefined) {
            byPath.set(row.path, [entry]);
        } else {
            list.push(entry);
        }
    }

    return byPath;
};

/**
 * Read the per-`(table, index)` hit counts — the advisor dead-index lint input.
 * Each entry is a declared index and how many recorded reads used it to narrow
 * (a cumulative, non-decaying count); the lint reconciles this against the schema
 * to flag a declared index that appears with zero reads (or not at all) as dead. Ordered
 * by table then index for stable output. Creates the table first so a read on a
 * never-exercised shard returns `[]`.
 */
const readFunctionMetricIndexHits = (sql: SqlExec): FunctionMetricIndexHit[] => {
    ensureFunctionMetricsTables(sql);

    const rows = runSql<{ index_name: string; reads: number; table_name: string }>(
        sql,
        `SELECT table_name, index_name, reads FROM "${FUNCTION_METRICS_INDEX_TABLE}" ORDER BY table_name ASC, index_name ASC LIMIT ${String(FUNCTION_METRICS_READ_LIMIT)}`,
    ).toArray();

    return rows.map((row): FunctionMetricIndexHit => {
        return { index: row.index_name, reads: row.reads, table: row.table_name };
    });
};

/**
 * Fold a dispatch's distinct full-scanned tables into an in-memory attribution
 * list, mirroring the per-`(path, table)` upsert {@link recordFunctionMetric}
 * applies to the durable `__lunora_metrics_scans` table. Kept here, beside its
 * SQL twin, so the one rule (one occurrence = +1 scan for that table, list
 * re-sorted busiest-first) lives in a single module — the in-memory copy exists
 * only for the warm-instance fallback when the durable read is unavailable.
 * Mutates and returns `into`.
 */
const mergeScanAttribution = (into: FunctionScanAttribution[], scanned: ReadonlyArray<string>): FunctionScanAttribution[] => {
    for (const table of scanned) {
        const entry = into.find((attribution) => attribution.table === table);

        if (entry === undefined) {
            into.push({ scans: 1, table });
        } else {
            entry.scans += 1;
        }
    }

    into.sort((a, b) => b.scans - a.scans || a.table.localeCompare(b.table));

    return into;
};

/**
 * Read the persisted per-function accumulators as {@link FunctionCallStat}s,
 * newest-called first. Creates the table first so reads on a never-called shard
 * return `[]` instead of throwing. The shape is a superset of the legacy
 * in-memory `getFunctionStats` rows — the additive `scans` total and
 * `scannedTables` causal attribution are folded in here so a single read backs
 * the Insights "missing index" / "full scan" signal.
 */
const readFunctionMetrics = (sql: SqlExec): FunctionCallStat[] => {
    ensureFunctionMetricsTables(sql);

    const scansByPath = readFunctionMetricScans(sql);

    // Bounded read: cap the materialized rows (newest-called first) so a bloated
    // accumulator table can't load millions of rows into the DO's ~128MB isolate
    // when the studio Function Stats panel opens.
    const rows = runSql<{
        calls: number;
        conflicts: number;
        errors: number;
        last_called_at: number;
        last_error_at: null | number;
        last_error_message: null | string;
        max_duration_ms: number;
        path: string;
        scans: number;
        total_duration_ms: number;
    }>(sql, `SELECT * FROM "${FUNCTION_METRICS_TABLE}" ORDER BY last_called_at DESC LIMIT ${String(FUNCTION_METRICS_READ_LIMIT)}`).toArray();

    return rows.map((row): FunctionCallStat => {
        return {
            calls: row.calls,
            conflicts: row.conflicts,
            errors: row.errors,
            lastCalledAt: row.last_called_at,
            lastErrorAt: row.last_error_at,
            lastErrorMessage: row.last_error_message,
            maxDurationMs: row.max_duration_ms,
            path: row.path,
            scannedTables: scansByPath.get(row.path) ?? [],
            scans: row.scans,
            totalDurationMs: row.total_duration_ms,
        };
    });
};

/**
 * Read the coarse time-series buckets for `path` (every path when omitted),
 * oldest-bucket first so a chart can plot them left-to-right. Creates the table
 * first so reads on a never-called shard return `{ buckets: [], truncated: false }`.
 */
const readFunctionMetricBuckets = (sql: SqlExec, path?: string): FunctionMetricBucketsResult => {
    ensureFunctionMetricsTables(sql);

    // Bounded like the other reads, and for the same reason: the all-paths arm is
    // what `getMetrics` calls on every Studio Metrics load, so its row count is
    // (tracked functions x retained buckets) — 100 active functions over a day of
    // minute-buckets is ~144k rows and ~60MB in a ~128MB isolate.
    //
    // Selected NEWEST-first so the cut drops the oldest history rather than the
    // most recent, then reversed to restore the oldest-first order a chart plots
    // left-to-right. Ordering the scan ASC and limiting would have kept the
    // stalest window and thrown away what the panel is actually for.
    //
    // LIMIT is one past the real cap so a full page of results (exactly
    // `FUNCTION_METRICS_READ_LIMIT + 1` rows back) is distinguishable from a read
    // that happened to end exactly at the cap — the extra row is trimmed below
    // and never returned, it only flips `truncated`.
    const rows =
        path === undefined
            ? runSql<{ bucket_ms: number; calls: number; errors: number; path: string }>(
                  sql,
                  `SELECT path, bucket_ms, calls, errors FROM "${FUNCTION_METRICS_BUCKETS_TABLE}" ORDER BY bucket_ms DESC, path ASC LIMIT ${String(FUNCTION_METRICS_READ_LIMIT + 1)}`,
              ).toArray()
            : runSql<{ bucket_ms: number; calls: number; errors: number; path: string }>(
                  sql,
                  `SELECT path, bucket_ms, calls, errors FROM "${FUNCTION_METRICS_BUCKETS_TABLE}" WHERE path = ? ORDER BY bucket_ms DESC LIMIT ${String(FUNCTION_METRICS_READ_LIMIT + 1)}`,
                  path,
              ).toArray();

    const truncated = rows.length > FUNCTION_METRICS_READ_LIMIT;
    const kept = truncated ? rows.slice(0, FUNCTION_METRICS_READ_LIMIT) : rows;

    return {
        buckets: kept.toReversed().map((row) => {
            return { bucketMs: row.bucket_ms, calls: row.calls, errors: row.errors, path: row.path };
        }),
        truncated,
    };
};

/**
 * Aggregate the persisted accumulators into the lifetime totals the metrics
 * health snapshot reports: total calls (`requests`), total `errors`, and the
 * earliest `last_called_at` seen — a best-effort "since" marker for durable
 * data. Returns zeroes on a never-called shard.
 */
const readFunctionMetricsTotals = (sql: SqlExec): { errors: number; requests: number } => {
    ensureFunctionMetricsTables(sql);

    const row = runSql<{ errors: null | number; requests: null | number }>(
        sql,
        `SELECT SUM(calls) AS requests, SUM(errors) AS errors FROM "${FUNCTION_METRICS_TABLE}"`,
    ).one();

    return { errors: row.errors ?? 0, requests: row.requests ?? 0 };
};

export {
    ensureFunctionMetricsTables,
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKET_RETENTION,
    FUNCTION_METRICS_BUCKETS_TABLE,
    FUNCTION_METRICS_INDEX_TABLE,
    FUNCTION_METRICS_MAX_PATHS,
    FUNCTION_METRICS_READ_LIMIT,
    FUNCTION_METRICS_SCANS_TABLE,
    FUNCTION_METRICS_TABLE,
    mergeScanAttribution,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricScans,
    readFunctionMetricsTotals,
    recordFunctionMetric,
};
export type { FunctionMetricBucket, FunctionMetricBucketsResult, FunctionMetricIndexHit, IndexHit, RecordFunctionMetricInput };
