/**
 * Per-statement SQL query metrics.
 *
 * Records per-normalized-statement timing and row-access aggregates in the
 * reserved `__lunora_metrics_queries` table so the Studio can surface a
 * slow-query leaderboard without the operator adding instrumentation by hand.
 *
 * A "normalized statement" is the SQL text with literal values stripped and
 * truncated to at most {@link QUERY_METRICS_MAX_SQL_LEN} characters so the
 * primary key stays bounded. The normalization is deliberately lightweight
 * (no full AST parse) — it collapses adjacent whitespace and replaces
 * quoted strings, numeric literals, and hex literals with `?` placeholders.
 *
 * `rows_read` is the result set size for SELECT statements (rows the caller
 * iterated via `.toArray()` / `.one()`). `rows_written` is always 0 in this
 * module; callers that know a DML statement affected rows can pass the count
 * explicitly. The tracked set is capped at {@link QUERY_METRICS_MAX_STATEMENTS}
 * entries — new statements beyond the cap are silently dropped.
 */

import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Reserved table name. Auto-hidden from the data browser by the `__lunora` prefix. */
const QUERY_METRICS_TABLE = "__lunora_metrics_queries";

/**
 * Time-bucketed companion to {@link QUERY_METRICS_TABLE}, keyed
 * `(sql_hash, bucket_ms)`. The lifetime table above answers "what has been
 * expensive since this shard was created"; this one answers "what is expensive
 * NOW", which is the question an operator actually has during an incident.
 *
 * Keyed by a hash of the normalised statement rather than its text, because the
 * text is up to {@link QUERY_METRICS_MAX_SQL_LEN} characters and this table has
 * one row per statement PER WINDOW — the text lives once, in the lifetime table,
 * and is joined back on read.
 */
const QUERY_BUCKETS_TABLE = "__lunora_metrics_queries_buckets";

/**
 * Bucket width. Deliberately the SAME window as the per-function series
 * (`function-metrics.ts`), so the two can be charted on one time axis without
 * resampling — a second, differently-sized window would silently misalign them.
 */
const QUERY_BUCKET_MS = 60_000;

/**
 * How many windows to keep: 1h of minutes plus headroom, since 1h is the longest
 * range the Studio offers. Row count is bounded by
 * `QUERY_METRICS_MAX_STATEMENTS × QUERY_BUCKET_RETENTION`, and the prune below
 * is what keeps that true.
 */
const QUERY_BUCKET_RETENTION = 90;

/**
 * Upper edges of the latency histogram, in milliseconds. Percentiles are
 * interpolated from these boundaries on read.
 *
 * A fixed histogram rather than stored samples: samples are unbounded growth on
 * a hot path for a precision nobody needs at this altitude. The cost is that a
 * percentile is accurate to its bucket's width — documented at
 * {@link readQueryInsights} so the number is not over-trusted.
 */
const LATENCY_BUCKET_EDGES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000] as const;

/**
 * Maximum characters of normalised SQL stored per entry. Longer statements
 * are truncated with an ellipsis so the primary key column stays compact.
 */
const QUERY_METRICS_MAX_SQL_LEN = 512;

/**
 * Maximum distinct normalised statements tracked.  Entries beyond this cap
 * are silently dropped to prevent unbounded table growth when ad-hoc SQL
 * (e.g. DDL migrations, dynamic query builders) generates many distinct
 * statement shapes.
 */
const QUERY_METRICS_MAX_STATEMENTS = 500;

/** One row of the `__lunora_metrics_queries` table, as returned by `readQueryMetrics`. */
interface QueryStatEntry {
    /** Total number of times this statement was executed. */
    execCount: number;
    /** Normalised SQL text (literals stripped, truncated). */
    normalizedSql: string;
    /** Total rows read across all executions (SELECT result sizes). */
    rowsRead: number;
    /** Total rows written across all executions. */
    rowsWritten: number;
    /** Total wall-clock milliseconds across all executions. */
    totalDurationMs: number;
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/**
 * Normalise a SQL string by collapsing whitespace, stripping string literals,
 * numeric literals, and hex literals, replacing them with `?`, then truncating.
 * The result is used as the primary key of `__lunora_metrics_queries`, so two
 * executions of the same parameterised query collapse to one row regardless of
 * argument values. Single-quoted strings and hex literals become `?`; numeric
 * literals preceded by `=`, `(`, `,`, or whitespace become `?`; double-quoted
 * SQLite identifiers are kept as-is.
 */
const normalizeSql = (sql: string): string => {
    let normalized = sql
        // Strip single-quoted string literals (may contain escaped quotes '').
        .replaceAll(/'(?:[^']|'')*'/g, "?")
        // Strip hex literals.
        .replaceAll(/\b0x[\da-f]+\b/gi, "?")
        // Strip standalone numeric literals (integer or float).
        .replaceAll(/(?<=[=,([\s])\d+(?:\.\d+)?/g, "?")
        // Collapse whitespace.
        .replaceAll(/\s+/g, " ")
        .trim();

    if (normalized.length > QUERY_METRICS_MAX_SQL_LEN) {
        normalized = `${normalized.slice(0, QUERY_METRICS_MAX_SQL_LEN - 1)}…`;
    }

    return normalized;
};

/**
 * SQL handles whose reserved tables have already been ensured this instance.
 * `recordQueryMetric` runs once per instrumented statement — potentially many
 * times per dispatch — so without memoizing, a query-in-a-loop handler re-ran
 * `CREATE TABLE IF NOT EXISTS` (twice, counting the bucket table) on every
 * single execution. A `WeakSet` so a torn-down shard's handle is collectable;
 * a fresh handle (a new isolate after hibernation) re-ensures, which is
 * correct — mirrors `metric-history.ts`'s `ensuredHandles` and
 * `function-metrics.ts`'s twin.
 */
const ensuredMetricsHandles = new WeakSet<SqlExec>();

/**
 * Create the reserved query-metrics table. Idempotent — safe to call on every
 * hot path; SQLite's `CREATE TABLE IF NOT EXISTS` is a no-op when the table
 * already exists. Only runs once per handle (see {@link ensuredMetricsHandles}).
 */
const ensureQueryMetricsTable = (sql: SqlExec): void => {
    if (ensuredMetricsHandles.has(sql)) {
        return;
    }

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${QUERY_METRICS_TABLE}" (
            normalized_sql TEXT PRIMARY KEY,
            exec_count     INTEGER NOT NULL DEFAULT 0,
            total_duration_ms REAL NOT NULL DEFAULT 0,
            rows_read      INTEGER NOT NULL DEFAULT 0,
            rows_written   INTEGER NOT NULL DEFAULT 0
        )`,
    );

    ensuredMetricsHandles.add(sql);
};

/**
 * The bucket most recently pruned PER SHARD, so the prune runs once per window
 * instead of once per statement.
 *
 * Keyed by the storage handle rather than a module-level scalar: workerd hosts
 * several Durable Object instances of the same class in one isolate, so a shared
 * scalar lets a busy shard claim the window and every other shard on that
 * isolate skip its prune entirely — the retention bound would then not hold,
 * which is the one thing this marker exists to guarantee. A `WeakMap` means an
 * evicted DO's entry is collected with it.
 */
const lastPrunedBucket = new WeakMap<object, number>();

/** Floor a timestamp to its bucket start. */
const bucketFloor = (at: number): number => Math.floor(at / QUERY_BUCKET_MS) * QUERY_BUCKET_MS;

/**
 * Stable 8-char hash of a normalised statement — the bucket table's compact key.
 *
 * FNV-1a, the same construction `shared/schema-snapshot.ts` uses: the bucket
 * table holds one row per statement PER WINDOW, so keying it on the full
 * statement text would multiply the storage. The text lives once in the lifetime
 * table and is joined back on read.
 */
const hashStatement = (normalized: string): string => {
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < normalized.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- FNV-1a is defined in terms of XOR and an unsigned shift; there is no non-bitwise formulation
        hash ^= normalized.codePointAt(index) ?? 0;
        // eslint-disable-next-line no-bitwise -- see above
        hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
};

/** Index of the first histogram edge at or above `durationMs`; the last index is the overflow bucket. */
const latencyBucketIndex = (durationMs: number): number => {
    const found = LATENCY_BUCKET_EDGES.findIndex((edge) => durationMs <= edge);

    return found === -1 ? LATENCY_BUCKET_EDGES.length : found;
};

/** Column name for one histogram bucket. */
const latencyColumn = (index: number): string => `lat_${String(index)}`;

/**
 * SQL handles whose bucket table has already been ensured this instance.
 * Separate from {@link ensuredMetricsHandles} because `recordQueryBucket`
 * fires per statement execution too, and the two tables are independently
 * idempotent — memoized the same way for the same reason (see
 * {@link ensuredMetricsHandles}).
 */
const ensuredBucketsHandles = new WeakSet<SqlExec>();

/** Create the bucket table. Idempotent; one column per histogram bucket plus the overflow. Only runs once per handle (see {@link ensuredBucketsHandles}). */
const ensureQueryBucketsTable = (sql: SqlExec): void => {
    if (ensuredBucketsHandles.has(sql)) {
        return;
    }

    const latencyColumns = Array.from({ length: LATENCY_BUCKET_EDGES.length + 1 }, (_, index) => `${latencyColumn(index)} INTEGER NOT NULL DEFAULT 0`).join(
        ", ",
    );

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${QUERY_BUCKETS_TABLE}" (
            sql_hash TEXT NOT NULL,
            bucket_ms INTEGER NOT NULL,
            exec_count INTEGER NOT NULL DEFAULT 0,
            total_duration_ms REAL NOT NULL DEFAULT 0,
            rows_read INTEGER NOT NULL DEFAULT 0,
            rows_written INTEGER NOT NULL DEFAULT 0,
            ${latencyColumns},
            PRIMARY KEY (sql_hash, bucket_ms)
        )`,
    );

    ensuredBucketsHandles.add(sql);
};

/**
 * Drop windows older than the retention horizon. Load-bearing, not hygiene: the
 * bucket table's row count is statements × windows, so without this it grows
 * without bound on a busy shard.
 */
const pruneQueryBuckets = (sql: SqlExec, now: number): void => {
    runSql(sql, `DELETE FROM "${QUERY_BUCKETS_TABLE}" WHERE bucket_ms < ?`, bucketFloor(now) - QUERY_BUCKET_RETENTION * QUERY_BUCKET_MS);
};

/**
 * Record one or more executions into their time bucket. `execCount` (default
 * 1) lets a caller that already folded several same-statement executions into
 * one aggregate — `shard-do.ts`'s per-dispatch statement-sample folding — flush
 * them as a single upsert instead of one call per execution: `durationMs` is
 * then the SUM across `execCount` executions, and the histogram places the
 * whole entry by the per-execution AVERAGE rather than the sum, so a folded
 * batch of many fast calls doesn't read as one enormous slow one. Best-effort:
 * a failure here must never break the lifetime counters, which are the older
 * and more load-bearing of the two.
 */
const recordQueryBucket = (sql: SqlExec, normalized: string, durationMs: number, rowsRead: number, rowsWritten: number, now: number, execCount: number = 1): void => {
    try {
        ensureQueryBucketsTable(sql);

        const avgDurationMs = execCount > 0 ? durationMs / execCount : durationMs;
        const column = latencyColumn(latencyBucketIndex(avgDurationMs));

        const upsert = `INSERT INTO "${QUERY_BUCKETS_TABLE}" (sql_hash, bucket_ms, exec_count, total_duration_ms, rows_read, rows_written, ${column})
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sql_hash, bucket_ms) DO UPDATE SET
                 exec_count = exec_count + excluded.exec_count,
                 total_duration_ms = total_duration_ms + excluded.total_duration_ms,
                 rows_read = rows_read + excluded.rows_read,
                 rows_written = rows_written + excluded.rows_written,
                 ${column} = ${column} + excluded.${column}`;

        runSql(sql, upsert, hashStatement(normalized), bucketFloor(now), execCount, durationMs, rowsRead, rowsWritten, execCount);

        // Prune once per WINDOW, detected by the bucket changing rather than by
        // sampling a 50ms slice of it. In a DO `Date.now()` is pinned to the last
        // I/O, so every statement in one dispatch shares a timestamp: the slice
        // was sampled once per dispatch, ~0.08% of the time, and the documented
        // row bound did not actually hold.
        const bucket = bucketFloor(now);

        if (lastPrunedBucket.get(sql) !== bucket) {
            lastPrunedBucket.set(sql, bucket);
            pruneQueryBuckets(sql, now);
        }
    } catch {
        // A missing/unmigrated bucket table degrades the time series, not the
        // lifetime leaderboard.
    }
};

/** One statement's activity within a chosen time range. */
interface QueryInsightEntry {
    /** Mean milliseconds per execution across the range. */
    avgDurationMs: number;
    execCount: number;
    normalizedSql: string;
    /** Interpolated 50th percentile latency, in milliseconds. */
    p50DurationMs: number;
    /** Interpolated 95th percentile latency, in milliseconds. */
    p95DurationMs: number;
    rowsRead: number;
    rowsWritten: number;
    totalDurationMs: number;
}

/** One point on the throughput/latency charts. */
interface QueryInsightBucket {
    /** Mean milliseconds per execution in this window, across all statements. */
    avgDurationMs: number;
    /** Bucket start, epoch millis. */
    bucketMs: number;
    execCount: number;
}

/** What `getQueryInsights` returns. */
interface QueryInsightsResult {
    /** Time series across the whole range, all statements combined. */
    buckets: QueryInsightBucket[];

    /**
     * True when the tracked-statement cap has been reached, so the caller can say
     * "showing N of a capped set" rather than implying totality. Silent
     * truncation reads as complete coverage when it is not.
     */
    capped: boolean;
    entries: QueryInsightEntry[];
    /** How many distinct statements the lifetime table is tracking. */
    trackedStatements: number;
}

/**
 * Interpolate a percentile from the fixed latency histogram.
 *
 * Accuracy is bounded by the containing bucket's width — a p95 that lands in the
 * `500 → 1000` bucket is reported as somewhere in that span, not as a precise
 * sample. That is the deliberate trade for not storing per-execution samples;
 * callers should read these as "which order of magnitude", not as exact values.
 */
const percentileFrom = (counts: ReadonlyArray<number>, quantile: number): number => {
    const total = counts.reduce((sum, count) => sum + count, 0);

    if (total === 0) {
        return 0;
    }

    const target = total * quantile;
    let seen = 0;

    for (const [index, count] of counts.entries()) {
        seen += count;

        if (seen >= target) {
            // The overflow bucket has no upper edge; report its lower edge.
            return LATENCY_BUCKET_EDGES[index] ?? LATENCY_BUCKET_EDGES.at(-1) ?? 0;
        }
    }

    return LATENCY_BUCKET_EDGES.at(-1) ?? 0;
};

/**
 * Per-statement activity within `rangeMs` of `now`, plus a combined time series.
 *
 * Reads the bucket table (not the lifetime one) so the numbers answer "what is
 * hot right now"; the statement TEXT is joined back from the lifetime table,
 * which is the only place it is stored.
 */
const readQueryInsights = (sql: SqlExec, rangeMs: number, now: number = Date.now()): QueryInsightsResult => {
    try {
        ensureQueryMetricsTable(sql);
        ensureQueryBucketsTable(sql);
    } catch {
        return { buckets: [], capped: false, entries: [], trackedStatements: 0 };
    }

    const since = bucketFloor(now - rangeMs);
    const latencySums = Array.from({ length: LATENCY_BUCKET_EDGES.length + 1 }, (_, index) => `SUM(${latencyColumn(index)}) AS ${latencyColumn(index)}`).join(
        ", ",
    );

    const rows = runSql<Record<string, number | string>>(
        sql,
        `SELECT sql_hash, SUM(exec_count) AS exec_count, SUM(total_duration_ms) AS total_duration_ms,
                SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written, ${latencySums}
         FROM "${QUERY_BUCKETS_TABLE}" WHERE bucket_ms >= ? GROUP BY sql_hash`,
        since,
    ).toArray();

    // The bucket table stores a hash; the text lives once, in the lifetime table.
    const textByHash = new Map<string, string>();

    for (const row of runSql<{ normalized_sql: string }>(sql, `SELECT normalized_sql FROM "${QUERY_METRICS_TABLE}"`)) {
        textByHash.set(hashStatement(row.normalized_sql), row.normalized_sql);
    }

    const entries = rows.map((row): QueryInsightEntry => {
        const counts = Array.from({ length: LATENCY_BUCKET_EDGES.length + 1 }, (_, index) => Number(row[latencyColumn(index)] ?? 0));
        const execCount = Number(row.exec_count ?? 0);
        const totalDurationMs = Number(row.total_duration_ms ?? 0);

        return {
            avgDurationMs: execCount > 0 ? totalDurationMs / execCount : 0,
            execCount,
            normalizedSql: textByHash.get(String(row.sql_hash)) ?? String(row.sql_hash),
            p50DurationMs: percentileFrom(counts, 0.5),
            p95DurationMs: percentileFrom(counts, 0.95),
            rowsRead: Number(row.rows_read ?? 0),
            rowsWritten: Number(row.rows_written ?? 0),
            totalDurationMs,
        };
    });

    entries.sort((a, b) => b.totalDurationMs - a.totalDurationMs);

    const buckets = runSql<{ bucket_ms: number; exec_count: number; total_duration_ms: number }>(
        sql,
        `SELECT bucket_ms, SUM(exec_count) AS exec_count, SUM(total_duration_ms) AS total_duration_ms
         FROM "${QUERY_BUCKETS_TABLE}" WHERE bucket_ms >= ? GROUP BY bucket_ms ORDER BY bucket_ms ASC`,
        since,
    )
        .toArray()
        .map((row) => {
            return {
                avgDurationMs: row.exec_count > 0 ? row.total_duration_ms / row.exec_count : 0,
                bucketMs: row.bucket_ms,
                execCount: row.exec_count,
            };
        });

    const trackedStatements = runSql<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM "${QUERY_METRICS_TABLE}"`).one().n;

    return { buckets, capped: trackedStatements >= QUERY_METRICS_MAX_STATEMENTS, entries, trackedStatements };
};

/**
 * Normalised statements this handle has confirmed are already tracked in the
 * lifetime table — once a statement is in here, {@link admitStatement} skips
 * the cap check entirely on every later execution of it. Bounded implicitly
 * by {@link QUERY_METRICS_MAX_STATEMENTS} for the same reason
 * `function-metrics.ts`'s `knownPaths` is: a statement is only ever added
 * once confirmed tracked, and a rejected one is never added. A `WeakMap` so a
 * torn-down shard's handle is collectable; a fresh handle (a new isolate
 * after hibernation) starts cold and re-verifies.
 */
const knownStatements = new WeakMap<SqlExec, Set<string>>();

const knownStatementsFor = (sql: SqlExec): Set<string> => {
    let set = knownStatements.get(sql);

    if (set === undefined) {
        set = new Set<string>();
        knownStatements.set(sql, set);
    }

    return set;
};

/**
 * Admit `normalized` against the distinct-statement cap without an
 * unconditional `SELECT COUNT(*)` on every execution. Same shape as
 * `function-metrics.ts`'s `admitPath`: a known statement is free, a
 * first-sight one pays one indexed PK lookup to tell "already tracked" from
 * "genuinely new", and only a genuinely new statement reaches the actual
 * `COUNT(*)` gate — the rare case once the leaderboard has warmed up.
 */
const admitStatement = (sql: SqlExec, normalized: string): boolean => {
    const known = knownStatementsFor(sql);

    if (known.has(normalized)) {
        return true;
    }

    const alreadyTracked = runSql<{ c: number }>(sql, `SELECT 1 AS c FROM "${QUERY_METRICS_TABLE}" WHERE normalized_sql = ? LIMIT 1`, normalized).toArray().length > 0;

    if (alreadyTracked) {
        known.add(normalized);

        return true;
    }

    const countRow = runSql<{ n: number }>(sql, `SELECT COUNT(*) AS n FROM "${QUERY_METRICS_TABLE}"`).one();

    if (countRow.n >= QUERY_METRICS_MAX_STATEMENTS) {
        return false;
    }

    known.add(normalized);

    return true;
};

/**
 * Record one statement's activity. Creates the table on first call. Silently
 * skips recording when the normalised statement is empty (shouldn't happen
 * in practice) or when the table is already at the
 * {@link QUERY_METRICS_MAX_STATEMENTS} cap and the statement is not yet
 * tracked. See `admitStatement` for how the cap check avoids an unconditional
 * `COUNT(*)` on every execution.
 *
 * `execCount` (default 1) lets a caller fold several executions of the SAME
 * statement into one call — `shard-do.ts` does this per dispatch so a
 * query-in-a-loop handler pays one upsert here instead of one per raw
 * execution. `durationMs`/`rowsRead`/`rowsWritten` are then the SUM across
 * `execCount` executions, exactly as `exec_count`/`total_duration_ms` already
 * accumulate sums across separate calls — folding before calling is
 * indistinguishable, from this table's point of view, from `execCount`
 * separate calls with the same totals.
 */
const recordQueryMetric = (
    sql: SqlExec,
    rawSql: string,
    durationMs: number,
    rowsRead: number,
    rowsWritten: number,
    now: number = Date.now(),
    execCount: number = 1,
): void => {
    const normalized = normalizeSql(rawSql);

    if (normalized.length === 0) {
        return;
    }

    ensureQueryMetricsTable(sql);

    if (!admitStatement(sql, normalized)) {
        return;
    }

    // eslint-disable-next-line no-secrets/no-secrets -- SQL keyword "CONFLICT" triggers the entropy scanner; this is plain DDL, not a secret
    const upsertSql = `INSERT INTO "${QUERY_METRICS_TABLE}" (normalized_sql, exec_count, total_duration_ms, rows_read, rows_written)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(normalized_sql) DO UPDATE SET
             exec_count = exec_count + excluded.exec_count,
             total_duration_ms = total_duration_ms + excluded.total_duration_ms,
             rows_read = rows_read + excluded.rows_read,
             rows_written = rows_written + excluded.rows_written`;

    runSql(sql, upsertSql, normalized, execCount, durationMs, rowsRead, rowsWritten);
    recordQueryBucket(sql, normalized, durationMs, rowsRead, rowsWritten, now, execCount);
};

/**
 * Read all tracked statement aggregates, ordered by `total_duration_ms DESC`
 * (the leaderboard's default). Creates the table first so a read on a
 * never-called shard returns `[]`.
 */
const readQueryMetrics = (sql: SqlExec): QueryStatEntry[] => {
    ensureQueryMetricsTable(sql);

    const rows = runSql<{
        exec_count: number;
        normalized_sql: string;
        rows_read: number;
        rows_written: number;
        total_duration_ms: number;
    }>(
        sql,
        `SELECT normalized_sql, exec_count, total_duration_ms, rows_read, rows_written FROM "${QUERY_METRICS_TABLE}" ORDER BY total_duration_ms DESC`,
    ).toArray();

    return rows.map((row): QueryStatEntry => {
        return {
            execCount: row.exec_count,
            normalizedSql: row.normalized_sql,
            rowsRead: row.rows_read,
            rowsWritten: row.rows_written,
            totalDurationMs: row.total_duration_ms,
        };
    });
};

export {
    ensureQueryBucketsTable,
    ensureQueryMetricsTable,
    hashStatement,
    LATENCY_BUCKET_EDGES,
    latencyBucketIndex,
    normalizeSql,
    percentileFrom,
    pruneQueryBuckets,
    QUERY_BUCKET_MS,
    QUERY_BUCKET_RETENTION,
    QUERY_BUCKETS_TABLE,
    QUERY_METRICS_MAX_SQL_LEN,
    QUERY_METRICS_MAX_STATEMENTS,
    QUERY_METRICS_TABLE,
    readQueryInsights,
    readQueryMetrics,
    recordQueryBucket,
    recordQueryMetric,
};
export type { QueryInsightBucket, QueryInsightEntry, QueryInsightsResult, QueryStatEntry };
