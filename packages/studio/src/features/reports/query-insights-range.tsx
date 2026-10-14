import type { ReactElement } from "react";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { QueryInsightBucket, QueryInsightRange, QueryInsightsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { cn } from "../../lib/utils";
import { QueryInsights } from "./query-insights";

/** Selector options, shortest first — the order an operator scans during an incident. */
const RANGES: ReadonlyArray<QueryInsightRange> = ["1m", "5m", "15m", "1h"];

/** Format a bucket start as a clock time for the chart axis. */
const bucketLabel = (bucketMs: number): string => new Date(bucketMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Shape the chart series consumes. */
interface ChartPoint {
    avg: number;
    execs: number;
    label: string;
}

const toChartPoints = (buckets: ReadonlyArray<QueryInsightBucket>): ChartPoint[] =>
    buckets.map((bucket) => {
        return { avg: Math.round(bucket.avgDurationMs * 100) / 100, execs: bucket.execCount, label: bucketLabel(bucket.bucketMs) };
    });

/**
 * Query insights over a chosen time window.
 *
 * The lifetime leaderboard this wraps answers "what has been expensive since
 * this shard was created" — useful, but not the question an operator has during
 * an incident. This reads the time-bucketed table instead, so selecting `1m`
 * ranks a statement hammered in the last minute above one that was hot last
 * week, and adds p50/p95 beside the mean because a mean hides the tail that is
 * usually what you are chasing.
 *
 * Percentiles are interpolated from a fixed latency histogram (see
 * `@lunora/do`'s `readQueryInsights`), so they are accurate to a bucket's width
 * rather than exact — read them as an order of magnitude.
 */
const QueryInsightsRange = ({ shardKey = "" }: { readonly shardKey?: string }): ReactElement => {
    const t = useT();

    const [range, setRange] = useState<QueryInsightRange>("15m");

    const insights = useAdminQuery<QueryInsightsResult>(ADMIN_FUNCTIONS.getQueryInsights, { range }, { live: true, shardKey });
    const result = insights.data;
    const points = toChartPoints(result?.buckets ?? []);

    return (
        <div className="flex flex-col gap-4" data-testid="qi-range">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1 rounded-lg border border-border p-0.5" data-testid="qi-ranges" role="group">
                    {RANGES.map((option) => (
                        <button
                            aria-pressed={option === range}
                            className={cn(
                                "rounded px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                                option === range && "bg-accent font-medium text-foreground",
                            )}
                            data-testid={`qi-range-${option}`}
                            key={option}
                            onClick={() => {
                                setRange(option);
                            }}
                            type="button"
                        >
                            {option}
                        </button>
                    ))}
                </div>

                {/* Never imply totality: past the cap, new statements are dropped. */}
                {result?.capped === true && (
                    <Badge data-testid="qi-capped" variant="secondary">
                        {t("showing a capped set")}
                    </Badge>
                )}
            </div>

            {points.length === 0 ? (
                <EmptyState
                    description={t("Statements executed in the selected window appear here, with throughput and latency over time.")}
                    testId="qi-empty"
                    title={t("No queries in this window.")}
                />
            ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                    <figure className="rounded-xl border border-border p-3" data-testid="qi-throughput">
                        <figcaption className="mb-2 text-xs font-medium text-muted-foreground">{t("Throughput")}</figcaption>
                        <ResponsiveContainer height={140} width="100%">
                            <AreaChart data={points}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="label" fontSize={10} tickLine={false} />
                                <YAxis allowDecimals={false} fontSize={10} tickLine={false} width={32} />
                                <Tooltip />
                                <Area dataKey="execs" fill="var(--color-primary)" fillOpacity={0.15} stroke="var(--color-primary)" type="monotone" />
                            </AreaChart>
                        </ResponsiveContainer>
                    </figure>

                    <figure className="rounded-xl border border-border p-3" data-testid="qi-latency">
                        <figcaption className="mb-2 text-xs font-medium text-muted-foreground">{t("Mean latency (ms)")}</figcaption>
                        <ResponsiveContainer height={140} width="100%">
                            <LineChart data={points}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="label" fontSize={10} tickLine={false} />
                                <YAxis fontSize={10} tickLine={false} width={32} />
                                <Tooltip />
                                <Line dataKey="avg" dot={false} stroke="var(--color-destructive)" type="monotone" />
                            </LineChart>
                        </ResponsiveContainer>
                    </figure>
                </div>
            )}

            <QueryInsights queryStats={result?.entries ?? []} />
        </div>
    );
};
export default QueryInsightsRange;
