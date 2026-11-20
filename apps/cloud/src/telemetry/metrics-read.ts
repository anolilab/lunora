/**
 * Read-back of tenant **metric series** from Analytics Engine (GAPS.md B2 / ring
 * 3 "metrics trend UI"). The write side (`store.ts` `recordMetrics`) lands every
 * `ctx.metrics.*` measurement as one AE data point —
 * `blob1=name`, `blob2=kind`, `blob3=functionPath`, `blob4=organizationId`,
 * `blob5=serviceName`, `double1=value`, `index1=name`. This module reads it back
 * over Cloudflare's Analytics SQL API, grouped into a per-metric time series for a
 * sparkline.
 *
 * **What AE CAN and CANNOT give us (the honest limit — never fabricate).** AE is
 * a sampling store: each retained row stands in for its sample interval's
 * originals, and `double1` is aggregated per time bucket (`AVG`, which the
 * Analytics SQL dialect sample-weights), so a returned series is an
 * **approximate trend**, not exact per-point values — good enough for a "is this
 * metric rising/falling, and roughly where is it now" sparkline, not for billing
 * math. Retention is bounded (AE keeps ~90 days), and only the numeric `double1`
 * is aggregatable. Arbitrary metric *names* ARE readable (they're `blob1`), so
 * the series list is real, live data — just sampled + bucket-averaged. The query
 * + row-folding are pure and unit-tested; `fetch` is injected so the read path
 * never touches the network in tests.
 */
import type { AnalyticsSqlRequest } from "@lunora/bindings/analytics-sql";

import type { AnalyticsSqlCredentials } from "./ae-sql";
import { analyticsEngineTable, bucketExpression, createRestAnalyticsSql, isoSeconds, KEY_SEPARATOR } from "./ae-sql";

/** One point on a metric's trend line: an epoch-ms bucket start + its bucket-averaged value. */
export interface MetricSeriesPoint {
    t: number;
    value: number;
}

/** One metric's series over the window — identity (name/kind/functionPath) + its trend points. */
export interface MetricSeries {
    /** Value of the earliest bucket in the window. */
    firstValue: number;
    /** The `&lt;file>:&lt;function>` the metric was emitted from, when attributed. */
    functionPath?: string;
    /** The metric kind the emitter tagged (`counter` / `gauge` / `histogram` / …). */
    kind: string;
    /** Value of the most recent bucket — the headline "last value". */
    lastValue: number;
    /** The metric name (`ctx.metrics.&lt;name>`). */
    name: string;
    /** Bucketed trend points, oldest→newest. */
    points: MetricSeriesPoint[];
    /** `lastValue − firstValue` — the window's net movement (sign = direction). */
    trend: number;
}

/** Default look-back when the caller gives no `from` (24 h). */
export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default bucket width for the trend (15 min) — ~96 points over 24 h. */
export const DEFAULT_METRICS_BUCKET_MS = 15 * 60 * 1000;

/** Hard cap on distinct series returned (bounds the response + the SVG fan-out). */
export const MAX_METRIC_SERIES = 50;

/** Inputs to {@link buildMetricSeriesQuery} — a bounded, org-scoped, time-bucketed read. */
export interface MetricQueryOptions {
    /** Bucket width in seconds (`timestamp` rounded down by `toStartOfInterval`). */
    bucketSec: number;
    /** AE dataset name the metrics land in. */
    dataset: string;
    /** Organization id — filters `blob4`. */
    organizationId: string;
    /** Lower bound (epoch seconds, exclusive). */
    sinceSec: number;
    /** Upper bound (epoch seconds, inclusive); omitted → open-ended. */
    toSec?: number;
}

/**
 * Build the Analytics SQL that folds the org's metric points into per-(name, kind,
 * functionPath) time buckets. `AVG(double1)` per bucket is the sample-weighted
 * trend value (see the module note on AE's sampling). Ordered so
 * {@link foldMetricRows} sees each series' buckets contiguously and oldest→newest.
 *
 * The org id and the window are bound parameters (`$organizationId`, `$since`,
 * `$to`), never spliced into the text.
 */
export const buildMetricSeriesQuery = (options: MetricQueryOptions): AnalyticsSqlRequest & { params: Record<string, string> } => {
    const upper = options.toSec === undefined ? "" : " AND timestamp <= $to";

    return {
        params: {
            organizationId: options.organizationId,
            since: isoSeconds(options.sinceSec),
            ...(options.toSec === undefined ? {} : { to: isoSeconds(options.toSec) }),
        },
        query: [
            `SELECT blob1 AS name, blob2 AS kind, blob3 AS functionPath, ${bucketExpression(options.bucketSec)} AS bucket, AVG(double1) AS value`,
            `FROM ${analyticsEngineTable(options.dataset)}`,
            `WHERE timestamp > $since${upper} AND blob4 = $organizationId`,
            `GROUP BY name, kind, functionPath, bucket`,
            `ORDER BY name, kind, functionPath, bucket`,
        ].join(" "),
    };
};

/** Coerce an AE cell (the SQL API can hand 64-bit numbers back as numeric strings) to a finite number. */
const asNumber = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Fold AE rows (`{ name, kind, functionPath, bucket, value }`, ordered by the
 * query) into per-metric {@link MetricSeries}. One series per distinct
 * `name|kind|functionPath`; `bucket` is epoch **seconds** → converted to ms.
 * `lastValue`/`firstValue`/`trend` come from the ordered points. Capped at
 * {@link MAX_METRIC_SERIES} distinct series.
 */
export const foldMetricRows = (rows: ReadonlyArray<Record<string, unknown>>): MetricSeries[] => {
    const byKey = new Map<string, MetricSeries>();

    for (const row of rows) {
        const name = asString(row.name);

        if (name === "") {
            continue;
        }

        const kind = asString(row.kind);
        const functionPath = asString(row.functionPath);
        const key = [name, kind, functionPath].join(KEY_SEPARATOR);
        const point: MetricSeriesPoint = { t: asNumber(row.bucket) * 1000, value: asNumber(row.value) };

        const existing = byKey.get(key);

        if (existing === undefined) {
            if (byKey.size >= MAX_METRIC_SERIES) {
                continue;
            }

            byKey.set(key, {
                firstValue: point.value,
                lastValue: point.value,
                name,
                points: [point],
                trend: 0,
                ...(functionPath === "" ? {} : { functionPath }),
                kind,
            });

            continue;
        }

        existing.points.push(point);
        existing.lastValue = point.value;
        existing.trend = existing.lastValue - existing.firstValue;
    }

    return [...byKey.values()];
};

/** Read a live metric-series snapshot for one org over a window. */
export interface MetricsReader {
    readSeries: (input: { from: number; organizationId: string; to?: number }) => Promise<MetricSeries[]>;
}

/** Options for {@link createMetricsReader}: the account creds + dataset (+ injectable `fetch`/bucket). */
export interface MetricsReaderOptions extends AnalyticsSqlCredentials {
    /** Bucket width in ms; defaults to {@link DEFAULT_METRICS_BUCKET_MS}. */
    bucketMs?: number;
    /** AE dataset the metrics land in (the `TELEMETRY` dataset by default). */
    dataset: string;
}

/**
 * HTTP {@link MetricsReader} over the Analytics SQL API (same read path as
 * `src/targets/cloudflare-wfp/analytics.ts`'s usage reader). Runs at the edge (needs the
 * account API token); pure query-building + folding are delegated to the tested
 * helpers above so this is a thin seam.
 */
export const createMetricsReader = (options: MetricsReaderOptions): MetricsReader => {
    const sql = createRestAnalyticsSql(options);
    const bucketSec = Math.max(Math.floor((options.bucketMs ?? DEFAULT_METRICS_BUCKET_MS) / 1000), 1);

    return {
        readSeries: async ({ from, organizationId, to }) => {
            const request = buildMetricSeriesQuery({
                bucketSec,
                dataset: options.dataset,
                organizationId,
                sinceSec: Math.floor(from / 1000),
                ...(to === undefined ? {} : { toSec: Math.floor(to / 1000) }),
            });

            const result = await sql.query(request.query, request.params);

            return foldMetricRows(result.rows);
        },
    };
};
