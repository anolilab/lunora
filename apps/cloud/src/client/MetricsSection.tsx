import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { formatValue } from "./metric-format";
import { Sparkline, TrendBadge } from "./MetricSparkline";
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
