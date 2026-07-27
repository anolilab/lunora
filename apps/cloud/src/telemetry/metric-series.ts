/**
 * Exact metric-series folding over the D1 `metricPoints` store — the precise tier
 * behind the Metrics UI. Unlike the Analytics-Engine reader (`metrics-read.ts`,
 * which is sampled + bucket-approximated), this averages **every** stored point
 * in a bucket, so the returned series is exact for the hot window. The output
 * shape is the same {@link MetricSeries} the AE reader yields, so the UI view is
 * identical whichever tier answers. Pure + unit-tested; the D1 read is in the
 * `metrics.series` query.
 */
import type { MetricSeries } from "./metrics-read";
import { DEFAULT_METRICS_BUCKET_MS, MAX_METRIC_SERIES } from "./metrics-read";

/** One exact measurement as the D1 `metricPoints` store holds it. */
export interface StoredMetricPoint {
    at: number;
    functionPath?: string;
    kind: string;
    name: string;
    value: number;
}

interface Accumulator {
    functionPath?: string;
    kind: string;
    name: string;
    /** bucket-start (epoch ms) → running sum + count, averaged on emit. */
    buckets: Map<number, { count: number; sum: number }>;
}

/**
 * Fold exact metric points into per-metric bucketed series. One series per
 * distinct `name|kind|functionPath`; each point falls in the bucket
 * `floor(at / bucketMs) * bucketMs` and every point in that bucket is averaged
 * (exact). Buckets are emitted oldest→newest; `firstValue`/`lastValue`/`trend`
 * come from the ordered buckets. Capped at {@link MAX_METRIC_SERIES} series.
 */
export const foldMetricSeries = (points: ReadonlyArray<StoredMetricPoint>, options: { bucketMs?: number } = {}): MetricSeries[] => {
    const bucketMs = Math.max(Math.trunc(options.bucketMs ?? DEFAULT_METRICS_BUCKET_MS), 1);
    const byKey = new Map<string, Accumulator>();

    for (const point of points) {
        if (point.name === "" || !Number.isFinite(point.value) || !Number.isFinite(point.at)) {
            continue;
        }

        const functionPath = point.functionPath ?? "";
        const key = `${point.name} ${point.kind} ${functionPath}`;
        let accumulator = byKey.get(key);

        if (accumulator === undefined) {
            if (byKey.size >= MAX_METRIC_SERIES) {
                continue;
            }

            accumulator = { buckets: new Map(), kind: point.kind, name: point.name, ...(functionPath === "" ? {} : { functionPath }) };
            byKey.set(key, accumulator);
        }

        const bucketStart = Math.floor(point.at / bucketMs) * bucketMs;
        const cell = accumulator.buckets.get(bucketStart);

        if (cell === undefined) {
            accumulator.buckets.set(bucketStart, { count: 1, sum: point.value });
        } else {
            cell.sum += point.value;
            cell.count += 1;
        }
    }

    const series: MetricSeries[] = [];

    for (const accumulator of byKey.values()) {
        const ordered = [...accumulator.buckets.entries()].sort((a, b) => a[0] - b[0]);
        const seriesPoints = ordered.map(([t, cell]) => ({ t, value: cell.sum / cell.count }));

        if (seriesPoints.length === 0) {
            continue;
        }

        const firstValue = seriesPoints[0].value;
        const lastValue = seriesPoints[seriesPoints.length - 1].value;

        series.push({
            firstValue,
            lastValue,
            name: accumulator.name,
            points: seriesPoints,
            trend: lastValue - firstValue,
            ...(accumulator.functionPath === undefined ? {} : { functionPath: accumulator.functionPath }),
            kind: accumulator.kind,
        });
    }

    return series;
};
