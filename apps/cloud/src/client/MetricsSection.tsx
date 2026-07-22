import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import type { OrgId } from "./types";

interface MetricsSectionProps {
    organizationId: OrgId;
}

/** One metric series as the `metrics.list` action returns it. */
interface MetricSeries {
    firstValue: number;
    functionPath?: string;
    kind: string;
    lastValue: number;
    name: string;
    points: { t: number; value: number }[];
    trend: number;
}

/** Compact number format for the headline last-value (`1.2k`, `3.4M`). */
const formatValue = (value: number): string => {
    const abs = Math.abs(value);

    if (abs >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }

    if (abs >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }

    return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

/**
 * A minimal inline-SVG sparkline over a metric's bucketed trend points. Points
 * are spaced evenly on x (by index) and scaled to the series' own min→max on y,
 * so a flat series still renders a centered line rather than dividing by zero.
 */
const Sparkline = ({ points }: { points: { t: number; value: number }[] }): ReactElement => {
    if (points.length === 0) {
        return <div className="metric-spark metric-spark-empty" />;
    }

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const step = points.length > 1 ? 100 / (points.length - 1) : 0;

    // y is inverted (SVG origin top-left): the max value sits at y=2, min at y=28.
    const coords = points.map((point, index) => `${(index * step).toFixed(2)},${(28 - ((point.value - min) / span) * 26).toFixed(2)}`).join(" ");

    return (
        <svg className="metric-spark" preserveAspectRatio="none" role="img" viewBox="0 0 100 30">
            {points.length === 1 ? (
                <circle cx="50" cy="15" r="1.5" />
            ) : (
                <polyline fill="none" points={coords} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
        </svg>
    );
};

/** Direction arrow + delta for a series' net movement over the window. */
const TrendBadge = ({ trend }: { trend: number }): ReactElement => {
    const direction = trend > 0 ? "up" : trend < 0 ? "down" : "flat";
    const arrow = trend > 0 ? "▲" : trend < 0 ? "▼" : "→";

    return (
        <span className={`metric-trend metric-trend-${direction}`}>
            {arrow} {formatValue(Math.abs(trend))}
        </span>
    );
};

/**
 * Metrics tab (GAPS.md ring 3) — per-metric trend sparklines over the tenant
 * `ctx.metrics.*` measurements Analytics Engine captures (`recordMetrics`). Reads
 * `metrics.list` (an action — the AE read is a `fetch`, so it can't be a live
 * query) for the shared time-range window; each series shows its name, kind, last
 * bucket-averaged value, a direction/trend badge, and an inline-SVG sparkline.
 *
 * The data is real but **sampled + bucket-averaged** (AE's storage model — see
 * `src/telemetry/metrics-read.ts`); it's an approximate trend, not exact points,
 * and it's empty until a cell provisions AE read credentials. It never fabricates
 * a series — an empty read renders the empty state.
 */
export const MetricsSection = ({ organizationId }: MetricsSectionProps): ReactElement => {
    const client = useLunora();
    const { from, to } = useTimeRange();
    const [series, setSeries] = useState<MetricSeries[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);

    // `metrics.list` is an action (not reactive), so poll it when the org or the
    // time-range window changes. Only the latest request may write state.
    useEffect(() => {
        let cancelled = false;

        // No synchronous reset here — state is written only in the async callbacks
        // (the sanctioned effect pattern), so the previous window's series shows
        // (stale-while-revalidate) until the new one resolves, and `cancelled`
        // guards against an out-of-order write.
        client
            .action(api.metrics.list, { from, organizationId, to })
            .then((result) => {
                if (!cancelled) {
                    setSeries(result);
                    setError(undefined);
                }
            })
            .catch((caught: unknown) => {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : "failed to load metrics");
                    setSeries([]);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, from, to, organizationId]);

    return (
        <div className="stack">
            <section className="card">
                <div className="metrics-head">
                    <h3>Metrics</h3>
                    <TimeRangePicker />
                </div>
                <p className="muted">
                    Trend of each <code>ctx.metrics.*</code> measurement over the selected window. Values are sampled and bucket-averaged by Analytics Engine —
                    an approximate trend, not exact points.
                </p>
            </section>

            {error ? (
                <section className="card">
                    <p className="callout error">{error}</p>
                </section>
            ) : null}

            {series === undefined ? (
                <section className="card">
                    <p className="muted">Loading…</p>
                </section>
            ) : null}

            {series !== undefined && series.length === 0 ? (
                <section className="card">
                    <p className="muted">
                        No metrics for this window. Emit measurements with <code>ctx.metrics.*</code> in your app (they land in Analytics Engine), then read
                        them back here once the cell has AE read credentials configured.
                    </p>
                </section>
            ) : null}

            {series !== undefined && series.length > 0 ? (
                <section className="card">
                    <div className="metric-grid">
                        {series.map((metric) => (
                            <div className="metric-tile" key={`${metric.name}:${metric.kind}:${metric.functionPath ?? ""}`}>
                                <div className="metric-tile-head">
                                    <div className="metric-tile-id">
                                        <span className="metric-name">{metric.name}</span>
                                        <span className="metric-kind">{metric.kind || "metric"}</span>
                                        {metric.functionPath ? <span className="log-fn">{metric.functionPath}</span> : null}
                                    </div>
                                    <div className="metric-tile-value">
                                        <span className="metric-last">{formatValue(metric.lastValue)}</span>
                                        <TrendBadge trend={metric.trend} />
                                    </div>
                                </div>
                                <Sparkline points={metric.points} />
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}
        </div>
    );
};
