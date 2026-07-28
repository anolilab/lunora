import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useT } from "../../i18n/i18n-context";
import type { EnrichedQueryStat } from "./metrics-aggregate";

/** Sort field options for the leaderboard. */
type SortField = "avgTime" | "execCount" | "rowsRead" | "totalTime";

/** Performance tier derived from the statement's average execution time. */
type PerformanceLevel = "critical" | "good" | "warning";

/**
 * Classify a statement's average execution time into a performance tier.
 * Returns `"critical"` at >= 100ms, `"warning"` at >= 50ms, and `"good"` below.
 */
const performanceLevel = (avgMs: number): PerformanceLevel => {
    if (avgMs >= 100) {
        return "critical";
    }

    if (avgMs >= 50) {
        return "warning";
    }

    return "good";
};

/** Format a millisecond duration as `μs`, `ms`, or `s`. */
const formatLatency = (ms: number): string => {
    if (ms < 1) {
        return `${(ms * 1000).toFixed(0)}μs`;
    }

    if (ms < 1000) {
        return `${ms.toFixed(1)}ms`;
    }

    return `${(ms / 1000).toFixed(2)}s`;
};

/** Format a large integer with K / M / B suffixes. */
const formatCount = (n: number): string => {
    if (n >= 1e9) {
        return `${(n / 1e9).toFixed(1)}B`;
    }

    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(1)}M`;
    }

    if (n >= 1e3) {
        return `${(n / 1e3).toFixed(1)}K`;
    }

    return n.toLocaleString();
};

/** Performance badge rendered inline beside the statement preview. */
const PerformanceBadge = ({ level }: { level: PerformanceLevel }): ReactElement => {
    if (level === "critical") {
        return <Badge variant="destructive">Slow</Badge>;
    }

    if (level === "warning") {
        return (
            <span className="inline-flex items-center gap-1 rounded-md border border-transparent bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                Moderate
            </span>
        );
    }

    return (
        <span className="inline-flex items-center gap-1 rounded-md border border-transparent bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
            Fast
        </span>
    );
};

interface QueryInsightsProps {
    /**
     * Per-statement aggregates. Accepts the ranged entries from
     * `getQueryInsights` (which carry p50/p95) as well as the lifetime
     * `EnrichedQueryStat` shape, so the same table serves both.
     */
    readonly queryStats: ReadonlyArray<EnrichedQueryStat & { p50DurationMs?: number; p95DurationMs?: number }>;
}

/**
 * Slow-query leaderboard for the Reports → Metrics panel.
 *
 * Renders a sortable table of per-statement SQL aggregates surfaced by the
 * `__lunora_admin__:getMetrics` RPC when the worker includes the
 * `queryStats` feed (workers predating the query-metrics feature return
 * `undefined` here — the parent panel guards on presence before mounting
 * this component). Each row carries a performance badge keyed on average
 * execution time, and the full normalised SQL can be expanded inline.
 *
 * Sort options: total time (default), avg time, execution count, rows read.
 */
export const QueryInsights = ({ queryStats }: QueryInsightsProps): ReactElement => {
    const t = useT();
    const [sortField, setSortField] = useState<SortField>("totalTime");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const handleSortChange = (value: string | null): void => {
        if (value !== null) {
            setSortField(value as SortField);
        }
    };

    const sorted = useMemo(() => {
        const copy = [...queryStats];

        copy.sort((a, b) => {
            switch (sortField) {
                case "avgTime": {
                    return b.avgDurationMs - a.avgDurationMs;
                }

                case "execCount": {
                    return b.execCount - a.execCount;
                }

                case "rowsRead": {
                    return b.rowsRead - a.rowsRead;
                }

                default: {
                    return b.totalDurationMs - a.totalDurationMs;
                }
            }
        });

        return copy;
    }, [queryStats, sortField]);

    const critical = queryStats.filter((q) => performanceLevel(q.avgDurationMs) === "critical").length;
    const moderate = queryStats.filter((q) => performanceLevel(q.avgDurationMs) === "warning").length;
    const fast = queryStats.filter((q) => performanceLevel(q.avgDurationMs) === "good").length;

    const toggleExpand = (key: string): void => {
        setExpanded((previous) => {
            const next = new Set(previous);

            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }

            return next;
        });
    };

    if (queryStats.length === 0) {
        return (
            <Card>
                <CardContent className="py-12">
                    <div className="text-center text-muted-foreground">
                        <p className="text-lg font-medium" data-testid="qi-empty">
                            {t("No query insights yet")}
                        </p>
                        <p className="mt-1 text-sm">{t("Query insights appear once statements are executed against this shard.")}</p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4" data-testid="qi-root">
            {/* Summary badges */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{t("Critical queries")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-destructive" data-testid="qi-critical">
                            {critical}
                        </div>
                        <p className="text-xs text-muted-foreground">{t(">100ms avg execution")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{t("Moderate queries")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-warning" data-testid="qi-moderate">
                            {moderate}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("50–100ms avg execution")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{t("Fast queries")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-success" data-testid="qi-fast">
                            {fast}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("<50ms avg execution")}</p>
                    </CardContent>
                </Card>
            </div>

            {/* Leaderboard header + sort control */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-semibold">{t("Query leaderboard")}</h3>
                    <p className="text-sm text-muted-foreground">{t("Slow queries sorted by {sortField}", { sortField: t(sortField) })}</p>
                </div>

                <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t("Sort by")}</span>
                    <Select onValueChange={handleSortChange} value={sortField}>
                        <SelectTrigger aria-label={t("Sort queries by")} className="w-[140px]" data-testid="qi-sort">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="totalTime">{t("Total time")}</SelectItem>
                            <SelectItem value="avgTime">{t("Avg time")}</SelectItem>
                            <SelectItem value="execCount">{t("Execution count")}</SelectItem>
                            <SelectItem value="rowsRead">{t("Rows read")}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>

            {/* Query rows */}
            <Card>
                <CardHeader>
                    <CardTitle>{t("Statements")}</CardTitle>
                    <CardDescription>{t("{count} tracked statements", { count: sorted.length })}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-2">
                        {sorted.map((stat) => {
                            const key = stat.normalizedSql;
                            const isExpanded = expanded.has(key);
                            const level = performanceLevel(stat.avgDurationMs);

                            return (
                                <div className="overflow-hidden rounded-lg border" data-testid="qi-row" key={key}>
                                    <button
                                        aria-expanded={isExpanded}
                                        className="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-muted/50"
                                        onClick={() => {
                                            toggleExpand(key);
                                        }}
                                        type="button"
                                    >
                                        <div className="flex min-w-0 flex-1 items-center gap-3">
                                            <PerformanceBadge level={level} />
                                            <span className="max-w-[300px] truncate font-mono text-sm lg:max-w-[500px]">{stat.normalizedSql}</span>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-4">
                                            <div className="text-right">
                                                <div className="text-sm font-medium">{formatLatency(stat.totalDurationMs)}</div>
                                                <div className="text-xs text-muted-foreground">{t("total")}</div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-sm font-medium">{formatLatency(stat.avgDurationMs)}</div>
                                                <div className="text-xs text-muted-foreground">{t("avg")}</div>
                                            </div>
                                            {/* p95 beside the mean, because a mean hides the tail — which is
                                                usually the thing being chased. Absent for the lifetime feed,
                                                which has no histogram to interpolate from. */}
                                            {stat.p95DurationMs !== undefined && (
                                                <div className="text-right">
                                                    <div className="text-sm font-medium">{formatLatency(stat.p95DurationMs)}</div>
                                                    <div className="text-xs text-muted-foreground">{t("p95")}</div>
                                                </div>
                                            )}
                                            <div className="text-right">
                                                <div className="text-sm font-medium">{formatCount(stat.execCount)}</div>
                                                <div className="text-xs text-muted-foreground">{t("calls")}</div>
                                            </div>
                                        </div>
                                    </button>

                                    {isExpanded && (
                                        <div className="space-y-3 border-t bg-muted/30 p-4">
                                            <div>
                                                <p className="mb-2 text-sm font-medium">{t("Full statement")}</p>
                                                <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm whitespace-pre-wrap break-all">
                                                    {stat.normalizedSql}
                                                </pre>
                                            </div>

                                            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                                                {stat.p50DurationMs !== undefined && (
                                                    <div>
                                                        <span className="text-muted-foreground">{t("p50")}</span>
                                                        <span className="block font-medium tabular-nums">{formatLatency(stat.p50DurationMs)}</span>
                                                    </div>
                                                )}
                                                <div>
                                                    <span className="text-muted-foreground">{t("Exec count")}</span>
                                                    <span className="block font-medium tabular-nums">{formatCount(stat.execCount)}</span>
                                                </div>
                                                <div>
                                                    <span className="text-muted-foreground">{t("Total time")}</span>
                                                    <span className="block font-medium tabular-nums">{formatLatency(stat.totalDurationMs)}</span>
                                                </div>
                                                <div>
                                                    <span className="text-muted-foreground">{t("Rows read")}</span>
                                                    <span className="block font-medium tabular-nums">{formatCount(stat.rowsRead)}</span>
                                                </div>
                                                <div>
                                                    <span className="text-muted-foreground">{t("Rows written")}</span>
                                                    <span className="block font-medium tabular-nums">{formatCount(stat.rowsWritten)}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

export type { QueryInsightsProps };
