// Pure formatting helpers for the Instruments table, kept out of the component
// file so it exports only its component (Fast Refresh preserves state), mirroring
// how `traces-panel` keeps its geometry in `trace-geometry`.
import type { MetricHistoryPoint, MetricKind, MetricSeries } from "../../lib/admin";
// Bundler-inlined, zero-dep canonical JSON encoder (the same one the server's
// series identity uses), imported by relative path per CLAUDE.md `shared/` rules.
import { stableStringify } from "../../../../../shared/stable-key";

/**
 * Stable identity for a series — kind, name, and a **canonical** encoding of its
 * dimensions — used to join a live {@link MetricSeries} (getMetricSeries) to its
 * durable history (getMetricHistory), which arrive over separate RPCs.
 *
 * The encoding MUST be key-order-independent: the live series carries attributes
 * in caller-insertion order while the history round-trips them through the
 * server's `stableStringify` (code-point-sorted), so a display encoder like
 * `formatLogFields` would place `{ route, method }` and `{ method, route }` under
 * different keys and the join would silently miss — blanking the trend for any
 * multi-dimension series. `stableStringify` sorts keys at every depth, so both
 * sides land on the same key regardless of authoring order.
 */
export const seriesMatchKey = (kind: MetricKind, name: string, attributes: Record<string, unknown> | undefined): string =>
    `${kind}:${name}:${stableStringify(attributes ?? {})}`;

/**
 * The value the panel projects for an instrument kind: a gauge's current reading,
 * a histogram's mean, a counter's running total. A histogram with no samples
 * can't divide, so `count` is floored at 1. The single source of truth for the
 * projection, so a series' headline number and the sparkline point beside it
 * provably agree — used for both a live {@link MetricSeries} and a history bucket.
 */
const projectByKind = (kind: MetricKind, metric: { count: number; last: number; sum: number }): number => {
    if (kind === "gauge") {
        return metric.last;
    }

    if (kind === "histogram") {
        return metric.sum / Math.max(1, metric.count);
    }

    return metric.sum;
};

/** Project one history bucket to the value the trend line plots (its per-kind projection). */
export const pointValue = (kind: MetricKind, point: MetricHistoryPoint): number => projectByKind(kind, point);

/** The headline value the panel shows for a live series (its per-kind projection). */
export const metricHeadline = (series: MetricSeries): number => projectByKind(series.kind, series);

/** Format a metric value: grouped integer, or up to 2 decimals for a fractional one. */
export const formatMetricValue = (value: number): string =>
    Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
