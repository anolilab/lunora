import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { formatValue } from "./metric-format";
import { Sparkline, TrendBadge } from "./MetricSparkline";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import type { OrgId } from "./types";

interface MetricsSectionProps {
    organizationId: OrgId;
}

/**
 * Metrics tab (GAPS.md ring 3) — per-metric trend sparklines over the tenant
 * `ctx.metrics.*` measurements. Reads `metrics.series` — a **live query** over the
 * exact D1 `metricPoints` store, where every measurement in a bucket is averaged
 * (precise, not sampled). Each series shows its name, kind, last value, a
 * direction/trend badge, and an inline-SVG sparkline, and updates reactively as
 * new points land. Empty until a tenant emits measurements; never fabricates a
 * series. (The sampled Analytics-Engine mirror, `metrics.list`, remains the
 * archive tier for windows older than the D1 hot retention.)
 *
 * The one tab that is NOT server-rendered: its series is keyed on the time range
 * the `TimeRangePicker` owns in client state, so there is nothing in the URL for a
 * loader to preload — and preloading a default window would go stale the moment
 * the picker moved. Everything else preloads in its route loader.
 */
export const MetricsSection = ({ organizationId }: MetricsSectionProps): ReactElement => {
    const { from, to } = useTimeRange();
    const series = useQuery(api.metrics.series, { from, organizationId, to });

    return (
        <div className="stack">
            <section className="card">
                <div className="metrics-head">
                    <h3>Metrics</h3>
                    <TimeRangePicker />
                </div>
                <p className="muted">
                    Trend of each <code>ctx.metrics.*</code> measurement over the selected window — exact per-bucket values from the hot store, updated live as
                    new measurements arrive.
                </p>
            </section>

            {series === undefined ? (
                <section className="card">
                    <p className="muted">Loading…</p>
                </section>
            ) : null}

            {series?.length === 0 ? (
                <section className="card">
                    <p className="muted">
                        No metrics for this window. Emit measurements with <code>ctx.metrics.*</code> in your app and they appear here as they arrive.
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
