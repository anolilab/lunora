import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { FunctionCallStat, FunctionStatsResult, ShardMetrics } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.js";
import type { Insight, InsightSeverity } from "./derive-insights.js";
import { deriveInsights } from "./derive-insights.js";
import type { TFunction } from "./i18n-context.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";

interface InsightsPanelProps {
    /** Shard key the snapshots target on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);
const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Badge variant per severity — reuses the design system's semantic colours. */
const SEVERITY_VARIANT: Record<InsightSeverity, "default" | "destructive" | "secondary"> = {
    error: "destructive",
    info: "secondary",
    warning: "default",
};

/** A 0–1 rate as a one-decimal percentage. */
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/** A millisecond figure as seconds (slow-function values are always ≥ 1s by construction). */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/** Localized headline per insight kind; the function path (when present) is rendered separately as code. */
const insightTitle = (t: TFunction, insight: Insight): string =>
    ({
        "high-error-rate": t("High error rate"),
        "high-evictions": t("High cache eviction rate"),
        "low-cache-hit-rate": t("Low cache hit rate"),
        "slow-function": t("Slow function"),
    })[insight.kind];

/** Localized one-line explanation per insight kind. */
const insightDetail = (t: TFunction, insight: Insight): string =>
    ({
        "high-error-rate": t("{rate} of calls failed.", { rate: percent(insight.value) }),
        "high-evictions": t("{count} entries evicted recently.", { count: insight.value }),
        "low-cache-hit-rate": t("{rate} hit rate over recent traffic.", { rate: percent(insight.value) }),
        "slow-function": t("Slowest call took {duration}.", { duration: seconds(insight.value) }),
    })[insight.kind];

/**
 * Read-only Insights overview: pulls the `getMetrics` health snapshot and the
 * `getFunctionStats` per-function table for one shard, then surfaces the issues
 * {@link deriveInsights} detects — low cache hit rate, high eviction, slow
 * functions, and error spikes — sorted worst-first. Both reads are best-effort
 * (either may fail on a missing `CIRRUS_ADMIN_TOKEN` or a cold instance) and the
 * panel still renders whatever it got. A snapshot, not a live feed — press
 * Refresh to re-pull.
 */
export const InsightsPanel = ({ initialShardKey }: InsightsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [functions, setFunctions] = useState<FunctionCallStat[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(false);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setLoading(true);

            const [snapshot, stats] = await Promise.allSettled([
                client.query(GET_METRICS, {}, callOptions(shard)) as Promise<ShardMetrics>,
                client.query(GET_FUNCTION_STATS, {}, callOptions(shard)) as Promise<FunctionStatsResult>,
            ]);

            // Surface an error only when BOTH reads fail — a partial snapshot
            // still yields useful insights, so one failure shouldn't blank it.
            if (snapshot.status === "rejected" && stats.status === "rejected") {
                setError(errorMessage(snapshot.reason));
            } else {
                setError(null);
                recordShard(shard);
            }

            setMetrics(snapshot.status === "fulfilled" ? snapshot.value : null);
            setFunctions(stats.status === "fulfilled" ? stats.value.functions : null);
            setLoading(false);
        },
        [client],
    );

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const insights = useMemo<Insight[]>(() => deriveInsights(metrics, functions), [metrics, functions]);

    return (
        <div className="space-y-4" data-testid="cirrus-insights">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="in-shard-input" value={shardKey} />
                <Button data-testid="in-refresh" disabled={loading} onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <Badge data-testid="in-count" variant={insights.length > 0 ? "default" : "outline"}>
                    {insights.length}
                </Badge>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="in-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && insights.length === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="in-empty">
                    {t("No issues detected.")}
                </p>
            )}

            {insights.length > 0 && (
                <ul className="space-y-3" data-testid="in-list">
                    {insights.map((insight) => (
                        <li key={`${insight.kind}:${insight.fn ?? ""}`}>
                            <Card className="rounded-md">
                                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                                    <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                        {insightTitle(t, insight)}
                                        {insight.fn !== undefined && <span className="font-mono text-xs text-muted-foreground">{insight.fn}</span>}
                                    </CardTitle>
                                    <Badge data-testid={`in-severity-${insight.severity}`} variant={SEVERITY_VARIANT[insight.severity]}>
                                        {insight.severity}
                                    </Badge>
                                </CardHeader>
                                <CardContent className="space-y-1 text-sm text-muted-foreground">
                                    <p>{insightDetail(t, insight)}</p>
                                    {insight.message !== undefined && <p className="font-mono text-xs text-destructive">{insight.message}</p>}
                                </CardContent>
                            </Card>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export type { InsightsPanelProps };
