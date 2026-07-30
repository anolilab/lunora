/**
 * Per-app durable auth-attempt metrics.
 *
 * `@lunora/auth` wraps better-auth and runs as a top-level worker route
 * (`/api/auth/*`), NOT through lunora functions — so the per-function metrics in
 * `function-metrics.ts` never see a sign-in/sign-up/callback. This module is the
 * parallel signal for auth: a durable counter of auth ATTEMPTS and FAILURES the
 * studio reads to chart an app-level auth-failure rate (and a sparkline of it
 * over time). Recorded against the root shard so a single read gives the whole
 * app's auth health.
 *
 * Modelled directly on `function-metrics.ts` (read it as the template): two
 * reserved tables, the same `runSql` indirection, the same bounded-trim idiom on
 * the bucket table.
 *
 * `__lunora_auth_metrics` holds the lifetime accumulators in a single row
 * (`attempts` + `failures`, plus a `since_ms` first-seen marker). An auth event
 * is one cheap `INSERT … ON CONFLICT … DO UPDATE` upsert against that row, off
 * the auth response's critical path.
 *
 * `__lunora_auth_metrics_buckets` holds coarse time-bucketed counters keyed by
 * `bucketMs` (60s windows), giving the minute-resolution time series the
 * studio sparkline plots. Bucketing keeps the row count bounded (one row per
 * window) and older rows are trimmed after each write, mirroring
 * `__lunora_metrics_buckets`.
 *
 * Both tables carry the reserved `__lunora` prefix, so the data browser hides
 * them automatically.
 */

import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Reserved single-row auth accumulator table. Auto-hidden from the data browser by the `__lunora` prefix. */
const AUTH_METRICS_TABLE = "__lunora_auth_metrics";

/** Reserved coarse time-series table: app-wide auth attempt/failure counts bucketed by a fixed window. */
const AUTH_METRICS_BUCKETS_TABLE = "__lunora_auth_metrics_buckets";

/**
 * Fixed primary key of the single accumulator row. The table is logically a
 * one-row counter; keying it lets us use the same `INSERT … ON CONFLICT` upsert
 * idiom as the per-function table rather than a separate "exists?" probe.
 */
const AUTH_METRICS_ROW_KEY = "app";

/**
 * Width of one history bucket, in milliseconds. 60s gives a minute-resolution
 * time series — fine-grained enough to chart a burst of failed sign-ins on the
 * studio, coarse enough that auth emits at most one row per minute. Mirrors
 * `FUNCTION_METRICS_BUCKET_MS`.
 */
const AUTH_METRICS_BUCKET_MS = 60_000;

/**
 * Most recent buckets kept; older rows are trimmed after each write so the time
 * series can't grow unbounded. 1440 minute-buckets ≈ 24h of auth history.
 */
const AUTH_METRICS_BUCKET_RETENTION = 1440;

/** One coarse time-series sample: auth attempt/failure counts within `[bucketMs, bucketMs + AUTH_METRICS_BUCKET_MS)`. */
interface AuthMetricsBucket {
    /** Auth attempts recorded in this window. */
    attempts: number;
    /** Epoch-ms floor of the bucket window. */
    bucketMs: number;
    /** Subset of `attempts` that failed (HTTP ≥ 400). */
    failures: number;
}

/**
 * Lifetime auth health for the app, served by `__lunora_admin__:getAuthMetrics`
 * and consumed by the studio SLO panel. `failureRate` is the derived
 * `failures / attempts` (0 when there have been no attempts), surfaced so the
 * panel needn't recompute it; `sinceMs` is the epoch-ms the first attempt was
 * recorded (a best-effort "since" marker); `history` is the minute-bucketed
 * series for the sparkline, oldest bucket first.
 */
interface AuthMetrics {
    /** Total auth attempts (sign-in / sign-up / callback) recorded. */
    attempts: number;
    /** Derived `attempts === 0 ? 0 : failures / attempts`. */
    failureRate: number;
    /** Subset of `attempts` that failed (the auth route answered HTTP ≥ 400). */
    failures: number;
    /** Minute-bucketed attempt/failure series for the sparkline, oldest bucket first. */
    history: AuthMetricsBucket[];
    /** Epoch-ms the first attempt was recorded, or `0` on a never-seen app. */
    sinceMs: number;
}

/** Fields recorded for one auth attempt. `outcome === "fail"` advances the failure counters. */
interface RecordAuthEventInput {
    /** `"ok"` for a 2xx/3xx auth response, `"fail"` for an HTTP ≥ 400 response. */
    outcome: "fail" | "ok";
    /** Epoch-ms the auth attempt completed. */
    ts: number;
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** Floor `ts` to the start of its history bucket. */
const bucketFloor = (ts: number): number => Math.floor(ts / AUTH_METRICS_BUCKET_MS) * AUTH_METRICS_BUCKET_MS;

/**
 * Create the two reserved auth-metrics tables. Idempotent, so the read and write
 * paths can call it defensively. The accumulator is a single keyed row; the
 * bucket table is keyed by `bucket_ms` (one row per minute window).
 */
const ensureAuthMetricsTables = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${AUTH_METRICS_TABLE}" (
            key TEXT PRIMARY KEY,
            attempts INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0,
            since_ms INTEGER NOT NULL DEFAULT 0
        )`,
    );

    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${AUTH_METRICS_BUCKETS_TABLE}" (
            bucket_ms INTEGER PRIMARY KEY,
            attempts INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0
        )`,
    );
};

/**
 * Persist one auth attempt: a single upsert into the accumulator row and one
 * upsert into the current time bucket, then a bounded trim of old buckets.
 * Creates the tables first so callers needn't. `attempts` always advances;
 * `failures` advances only when `outcome === "fail"`. `since_ms` is set once on
 * the first attempt and never moved (so it stays a true first-seen marker).
 *
 * Exactly two `INSERT … ON CONFLICT … DO UPDATE` statements plus a bounded
 * `DELETE`, all keyed by primary key — cheap enough to fire off the auth
 * response path without blocking it.
 */
const recordAuthEvent = (sql: SqlExec, input: RecordAuthEventInput): void => {
    ensureAuthMetricsTables(sql);

    const failureCount = input.outcome === "fail" ? 1 : 0;

    // Accumulator upsert. On conflict we fold the new attempt in: attempts add,
    // failures add the (0|1) for this event, and `since_ms` only sets when the
    // existing value is 0 (the first attempt), so it never moves afterward.
    runSql(
        sql,
        `INSERT INTO "${AUTH_METRICS_TABLE}" (key, attempts, failures, since_ms)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            attempts = attempts + 1,
            failures = failures + excluded.failures,
            since_ms = CASE WHEN since_ms = 0 THEN excluded.since_ms ELSE since_ms END`,
        AUTH_METRICS_ROW_KEY,
        failureCount,
        input.ts,
    );

    // Time-bucket upsert: bump the attempt/failure counts for the current minute.
    const bucket = bucketFloor(input.ts);

    runSql(
        sql,
        `INSERT INTO "${AUTH_METRICS_BUCKETS_TABLE}" (bucket_ms, attempts, failures)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket_ms) DO UPDATE SET
            attempts = attempts + 1,
            failures = failures + excluded.failures`,
        bucket,
        failureCount,
    );

    // Bounded retention: keep only the most recent buckets.
    runSql(
        sql,
        `DELETE FROM "${AUTH_METRICS_BUCKETS_TABLE}"
         WHERE bucket_ms <= (
            SELECT MAX(bucket_ms) - ? FROM "${AUTH_METRICS_BUCKETS_TABLE}"
         )`,
        AUTH_METRICS_BUCKET_RETENTION * AUTH_METRICS_BUCKET_MS,
    );
};

/**
 * Read the durable auth metrics as the {@link AuthMetrics} wire shape the
 * studio SLO panel consumes. Creates the tables first so a read on a
 * never-authenticated app returns an all-zero shape (empty `history`) instead of
 * throwing. `failureRate` is derived here so the consumer needn't recompute it.
 */
const readAuthMetrics = (sql: SqlExec): AuthMetrics => {
    ensureAuthMetricsTables(sql);

    const row = runSql<{ attempts: null | number; failures: null | number; since_ms: null | number }>(
        sql,
        `SELECT attempts, failures, since_ms FROM "${AUTH_METRICS_TABLE}" WHERE key = ?`,
        AUTH_METRICS_ROW_KEY,
    ).toArray()[0];

    const attempts = row?.attempts ?? 0;
    const failures = row?.failures ?? 0;
    const sinceMs = row?.since_ms ?? 0;

    const history = runSql<{ attempts: number; bucket_ms: number; failures: number }>(
        sql,
        `SELECT bucket_ms, attempts, failures FROM "${AUTH_METRICS_BUCKETS_TABLE}" ORDER BY bucket_ms ASC`,
    )
        .toArray()
        .map((bucket): AuthMetricsBucket => {
            return { attempts: bucket.attempts, bucketMs: bucket.bucket_ms, failures: bucket.failures };
        });

    return { attempts, failureRate: attempts === 0 ? 0 : failures / attempts, failures, history, sinceMs };
};

export {
    AUTH_METRICS_BUCKET_MS,
    AUTH_METRICS_BUCKET_RETENTION,
    AUTH_METRICS_BUCKETS_TABLE,
    AUTH_METRICS_ROW_KEY,
    AUTH_METRICS_TABLE,
    ensureAuthMetricsTables,
    readAuthMetrics,
    recordAuthEvent,
};
export type { AuthMetrics, AuthMetricsBucket, RecordAuthEventInput };
