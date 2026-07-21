// Pure formatting helpers for the Instruments table, kept out of the component
// file so it exports only its component (Fast Refresh preserves state), mirroring
// how `traces-panel` keeps its geometry in `trace-geometry`.
import type { MetricSeries } from "../../lib/admin";

/**
 * The headline value the panel shows for a series, projected by instrument kind:
 * a gauge's current reading, a histogram's mean, a counter's running total. A
 * histogram with no samples can't divide, so `count` is floored at 1 (the series
 * always has ≥1 sample once it exists, but this keeps the helper total).
 */
export const metricHeadline = (series: MetricSeries): number => {
    if (series.kind === "gauge") {
        return series.last;
    }

    if (series.kind === "histogram") {
        return series.sum / Math.max(1, series.count);
    }

    return series.sum;
};

/** Format a metric value: grouped integer, or up to 2 decimals for a fractional one. */
export const formatMetricValue = (value: number): string =>
    Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
