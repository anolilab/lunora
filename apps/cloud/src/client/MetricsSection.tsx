import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import { formatValue } from "./metric-format";
import { Sparkline, TrendBadge } from "./MetricSparkline";
import { COLUMN_LABEL } from "./section-ui";
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
 *
 * Hierarchy: each tile leads with its LAST VALUE at display size in mono — the
 * number is the visual, per "data as beauty" — with the metric name secondary and
 * kind/function path tertiary in the mono label voice. The sparkline sits below as
 * supporting shape, not as the headline. Loading and empty are plain inline text
 * rather than skeletons, which the system forbids.
 */
export const MetricsSection = ({ organizationId }: MetricsSectionProps): ReactElement => {
    const { from, to } = useTimeRange();
    const series = useQuery(api.metrics.series, { from, organizationId, to });

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Metrics</CardTitle>
                        <CardDescription>
                            Trend of each <code className="font-mono text-xs">ctx.metrics.*</code> measurement over the selected window — exact per-bucket values
                            from the hot store, updated live as new measurements arrive.
                        </CardDescription>
                    </div>
                    <TimeRangePicker />
                </CardHeader>
            </Card>

            {series === undefined ? (
                <Card>
                    <CardContent className="text-muted-foreground py-8 text-center font-mono text-xs tracking-[0.09em] uppercase">[Loading…]</CardContent>
                </Card>
            ) : null}

            {series?.length === 0 ? (
                <Card>
                    <CardContent className="text-muted-foreground py-8 text-center text-sm">
                        No metrics for this window. Emit measurements with <code className="font-mono text-xs">ctx.metrics.*</code> in your app and they appear
                        here as they arrive.
                    </CardContent>
                </Card>
            ) : null}

            {series !== undefined && series.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {series.map((metric) => (
                        <Card key={`${metric.name}:${metric.kind}:${metric.functionPath ?? ""}`}>
                            <CardContent className="flex flex-col gap-4 pt-6">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <span className="truncate text-sm font-medium">{metric.name}</span>
                                        <span className={`${COLUMN_LABEL} text-muted-foreground`}>{metric.kind || "metric"}</span>
                                        {metric.functionPath ? (
                                            <span className="text-muted-foreground truncate font-mono text-[11px]">{metric.functionPath}</span>
                                        ) : null}
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                                        {/* The tile's primary layer: the value, large and mono. */}
                                        <span className="font-mono text-2xl leading-none tabular-nums">{formatValue(metric.lastValue)}</span>
                                        <TrendBadge trend={metric.trend} />
                                    </div>
                                </div>
                                <Sparkline points={metric.points} />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : null}
        </div>
    );
};
