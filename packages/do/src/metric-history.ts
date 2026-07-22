/**
 * Per-shard durable history for `ctx.metrics.*` measurements.
 *
 * The in-memory {@link file://./metric-buffer.ts} folds measurements into a live
 * "right now on this instance" readout that resets on hibernation — great for the
 * current value, useless for a trend. This module is the durable complement: one
 * reserved SQLite table of per-minute time-bucket rollups that survive
 * hibernation/restart, so the studio can chart a series over time without an
 * external collector.
 *
 * Modelled directly on `function-metrics.ts`'s `__lunora_metrics_buckets` (same
 * bucket width, same bounded-retention trim, same distinct-key cap for
 * attacker-reachable keys). One row per `(series, bucket)`, written with a single
 * PK-keyed `INSERT … ON CONFLICT … DO UPDATE` upsert plus a bounded `DELETE`.
 *
 * Each bucket also carries an **exemplar**: a sample `traceId` of a measurement
 * folded into it, so the studio can jump from a point on the chart to a trace
 * that produced it (OpenTelemetry's exemplar model). The reserved `__lunora`
 * prefix auto-hides the table from the data browser.
 */
import type { LogFields } from "../../../shared/log-fields";
import type { MetricEvent, MetricKind } from "../../../shared/metric-event";
import { stableStringify } from "../../../shared/stable-key";
import type { SqlCursor, SqlExec } from "./ctx-db";
// Shared so the durable history and the live buffer agree byte-for-byte on what
// "one series" is — the studio joins the two on this identity.
import { metricSeriesKey } from "./metric-buffer";

/** Reserved per-`(series, minute)` rollup table. Auto-hidden from the data browser by the `__lunora` prefix. */
const METRIC_HISTORY_TABLE = "__lunora_metric_history";

/** Width of one history bucket, in ms — 60s, matching `function-metrics.ts` so both series align on the same minute grid. */
const METRIC_HISTORY_BUCKET_MS = 60_000;

/** Most recent buckets kept per series before older rows are trimmed. 1440 minute-buckets ≈ 24h of history per series. */
const METRIC_HISTORY_BUCKET_RETENTION = 1440;

/**
 * Maximum distinct series tracked. A series' identity includes its
 * caller-supplied `name` and `attributes`, and an id-valued attribute mints a new
 * series per id — so without a cap a high-cardinality dimension would grow the
 * table without bound and eventually crowd the app's own data out of the shard's
 * SQLite. Mirrors `function-metrics.ts`'s `FUNCTION_METRICS_MAX_PATHS`: at the
 * cap a brand-new series is dropped while already-tracked ones keep accumulating.
 */
const METRIC_HISTORY_MAX_SERIES = 1000;

/** Upper bound on bucket rows a single read materializes into DO memory, clamping a bloated pre-cap table like `function-metrics.ts`. */
const METRIC_HISTORY_READ_LIMIT = 5000;

/** One time-bucket sample of a series: the aggregate over `[bucketMs, bucketMs + METRIC_HISTORY_BUCKET_MS)`. */
interface MetricHistoryPoint {
    /** Epoch-ms floor of the bucket window. */
    bucketMs: number;
    /** Measurements folded into this bucket. */
    count: number;
    /** Sample `traceId` of a measurement in this bucket, if one carried trace context — the exemplar. */
    exemplarTraceId?: string;
    /** Last measured value in the bucket — a gauge's reading at the window's end. */
    last: number;
    /** Largest value in the bucket. */
    max: number;
    /** Smallest value in the bucket. */
    min: number;
    /** Sum of values in the bucket — a counter's increment total, a histogram's sum. */
    sum: number;
}

/** One series' durable history: its identity plus its time-ordered buckets, oldest first. */
interface MetricHistorySeries {
    attributes?: LogFields;
    functionPath: string;
    kind: MetricKind;
    name: string;
    /** Buckets in ascending `bucketMs` order, ready to chart as a line. */
    points: MetricHistoryPoint[];
    shardKey?: string;
}

/** {@link readMetricHistory} result: every tracked series with its buckets. */
interface MetricHistoryResult {
    series: MetricHistorySeries[];
}

/** Row shape of the reserved table, as SQLite hands it back. */
interface MetricHistoryRow {
    attrs: string;
    bucket_ms: number;
    count: number;
    exemplar_trace: null | string;
    function_path: string;
    kind: string;
    last: number;
    max: number;
    min: number;
    name: string;
    series_key: string;
    shard_key: null | string;
    sum: number;
}

const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...parameters: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...parameters);
};

/** Floor a timestamp to its minute-bucket, so all measurements in a window fold into one row. */
const bucketFloor = (ts: number): number => Math.floor(ts / METRIC_HISTORY_BUCKET_MS) * METRIC_HISTORY_BUCKET_MS;

const ensureMetricHistoryTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${METRIC_HISTORY_TABLE}" (
            series_key TEXT NOT NULL,
            bucket_ms INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            attrs TEXT NOT NULL DEFAULT '{}',
            function_path TEXT NOT NULL DEFAULT '',
            shard_key TEXT,
            count INTEGER NOT NULL DEFAULT 0,
            sum REAL NOT NULL DEFAULT 0,
            min REAL NOT NULL DEFAULT 0,
            max REAL NOT NULL DEFAULT 0,
            last REAL NOT NULL DEFAULT 0,
            last_ts REAL NOT NULL DEFAULT 0,
            exemplar_trace TEXT,
            PRIMARY KEY (series_key, bucket_ms)
        )`,
    );
};

/**
 * Fold one measurement into its `(series, minute)` bucket. Runs per
 * `ctx.metrics.*` call (unlike `function-metrics.ts`, which runs once per
 * dispatch), so it's tuned for the in-minute repeat: an existing bucket costs a
 * single point-lookup + upsert, and only a genuinely new bucket also pays the
 * distinct-series cap scan + retention trim. Still a durable SQLite write per
 * measurement, so a hot loop recording thousands of points a second should
 * pre-aggregate and record once (see `shared/metric-event.ts`). Creates the table
 * first so callers needn't.
 *
 * `exemplarTraceId` (the recording dispatch's trace, when it had one) is stored on
 * the bucket so the studio can link a chart point back to a trace. Latest wins:
 * a later sample carrying a trace replaces an earlier bucket's exemplar.
 */
const recordMetricHistory = (sql: SqlExec, event: MetricEvent, exemplarTraceId?: string): void => {
    ensureMetricHistoryTable(sql);

    const key = metricSeriesKey(event);
    const bucket = bucketFloor(event.ts);

    // Fast path for a metrics-heavy handler (a tight `ctx.metrics.*` loop): a
    // repeated measurement of the same series within the same minute just bumps an
    // existing bucket. One PK point-lookup detects that, so the common in-minute
    // case is a single upsert — the distinct-series cap scan and the retention trim
    // both run only when a *new* bucket appears (≈ once per series per minute).
    const bucketExists =
        runSql<{ c: number }>(sql, `SELECT 1 AS c FROM "${METRIC_HISTORY_TABLE}" WHERE series_key = ? AND bucket_ms = ? LIMIT 1`, key, bucket).toArray()
            .length > 0;

    if (!bucketExists) {
        // Distinct-series cap (mirrors `function-metrics.ts`): a new bucket for a
        // brand-new series must respect the limit so a high-cardinality dimension
        // can't grow the table without bound. Only the genuinely-new-series case
        // pays the `COUNT(DISTINCT series_key)` scan; an existing series recording
        // into a new minute skips it, and an in-minute update never reaches here.
        const seriesTracked = runSql<{ c: number }>(sql, `SELECT 1 AS c FROM "${METRIC_HISTORY_TABLE}" WHERE series_key = ? LIMIT 1`, key).toArray().length > 0;

        if (!seriesTracked) {
            const seriesCountRow = runSql<{ n: number }>(sql, `SELECT COUNT(DISTINCT series_key) AS n FROM "${METRIC_HISTORY_TABLE}"`).one();

            if (seriesCountRow.n >= METRIC_HISTORY_MAX_SERIES) {
                return;
            }
        }
    }

    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct "no exemplar" value; coalesced in on the first sample that carries a trace.
    const exemplar = exemplarTraceId ?? null;

    runSql(
        sql,
        `INSERT INTO "${METRIC_HISTORY_TABLE}"
            (series_key, bucket_ms, name, kind, attrs, function_path, shard_key, count, sum, min, max, last, last_ts, exemplar_trace)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(series_key, bucket_ms) DO UPDATE SET
            count = count + 1,
            sum = sum + excluded.sum,
            min = MIN(min, excluded.min),
            max = MAX(max, excluded.max),
            last = excluded.last,
            last_ts = excluded.last_ts,
            exemplar_trace = CASE WHEN excluded.exemplar_trace IS NULL THEN exemplar_trace ELSE excluded.exemplar_trace END`,
        key,
        bucket,
        event.name,
        event.kind,
        stableStringify(event.attributes ?? {}),
        event.functionPath,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL for the unnamed root DO's absent shard key.
        event.shardKey ?? null,
        event.value,
        event.value,
        event.value,
        event.value,
        event.ts,
        exemplar,
    );

    // Bounded retention: keep only the most recent buckets for this series. Only
    // when a new bucket was added — an in-minute update grows nothing, so re-running
    // the `MAX(bucket_ms)` subquery + range delete on every measurement is waste.
    if (!bucketExists) {
        runSql(
            sql,
            `DELETE FROM "${METRIC_HISTORY_TABLE}"
             WHERE series_key = ?
               AND bucket_ms <= (
                SELECT MAX(bucket_ms) - ? FROM "${METRIC_HISTORY_TABLE}" WHERE series_key = ?
               )`,
            key,
            METRIC_HISTORY_BUCKET_RETENTION * METRIC_HISTORY_BUCKET_MS,
            key,
        );
    }
};

/** Parse a stored `attrs` JSON blob back into a fields bag, tolerating a malformed value rather than throwing on a read. */
const parseAttributes = (raw: string): LogFields | undefined => {
    if (raw === "" || raw === "{}") {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        return parsed !== null && typeof parsed === "object" ? (parsed as LogFields) : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Read the durable history, grouped into one {@link MetricHistorySeries} per
 * series with its buckets in ascending time order.
 *
 * Rows are fetched most-recent-first (`bucket_ms DESC`) under the row cap, NOT
 * `series_key`-ordered: all active series write the same recent minutes, so this
 * windows every series to a recent slice fairly, instead of handing the
 * alphabetically-first series its full 1440-bucket history and starving the rest
 * once the cap is hit. Each series' points are re-sorted ascending below, since a
 * trend line reads oldest→newest.
 *
 * `options.sinceMs`, when set, returns only buckets at or after this epoch-ms —
 * the studio's time-window selector.
 */
const readMetricHistory = (sql: SqlExec, options: { sinceMs?: number } = {}): MetricHistoryResult => {
    ensureMetricHistoryTable(sql);

    const rows =
        options.sinceMs === undefined
            ? runSql<MetricHistoryRow>(sql, `SELECT * FROM "${METRIC_HISTORY_TABLE}" ORDER BY bucket_ms DESC LIMIT ?`, METRIC_HISTORY_READ_LIMIT).toArray()
            : runSql<MetricHistoryRow>(
                  sql,
                  `SELECT * FROM "${METRIC_HISTORY_TABLE}" WHERE bucket_ms >= ? ORDER BY bucket_ms DESC LIMIT ?`,
                  options.sinceMs,
                  METRIC_HISTORY_READ_LIMIT,
              ).toArray();

    const bySeries = new Map<string, MetricHistorySeries>();

    for (const row of rows) {
        let series = bySeries.get(row.series_key);

        if (series === undefined) {
            const attributes = parseAttributes(row.attrs);

            series = {
                ...(attributes === undefined ? {} : { attributes }),
                functionPath: row.function_path,
                kind: row.kind as MetricKind,
                name: row.name,
                points: [],
                ...(row.shard_key === null ? {} : { shardKey: row.shard_key }),
            };
            bySeries.set(row.series_key, series);
        }

        series.points.push({
            bucketMs: row.bucket_ms,
            count: row.count,
            ...(row.exemplar_trace === null ? {} : { exemplarTraceId: row.exemplar_trace }),
            last: row.last,
            max: row.max,
            min: row.min,
            sum: row.sum,
        });
    }

    // Rows arrived newest-first (bucket_ms DESC); a chart wants oldest-first.
    for (const series of bySeries.values()) {
        series.points.sort((a, b) => a.bucketMs - b.bucketMs);
    }

    return { series: [...bySeries.values()] };
};

export { readMetricHistory, recordMetricHistory };
export type { MetricHistoryPoint, MetricHistoryResult, MetricHistorySeries };
