import type { ReactElement } from "react";

import { StatCard } from "../../components/stat-card";
import { useT } from "../../i18n/i18n-context";
import type { ShardMetrics } from "../../lib/admin";
import { formatBytes } from "../../lib/internal";
import { formatElapsed, formatLatency, hitRate } from "./metrics-format";
import { Sparkline } from "./sparkline";

/**
 * The single-shard readout: requests with their sparkline, errors and error
 * rate, p90/p95 latency, database size, shard id, and uptime.
 *
 * Its own component because it is pure presentation of ONE snapshot — every
 * value derives from `metrics` plus the two series numbers, and none of it
 * touches the panel's fetch, fan-out, or tab state.
 */
const MetricsOverviewStats = ({
    currentDelta,
    errorRate,
    history,
    latencyPercentiles,
    metrics,
}: {
    /** Requests added in the newest sample, shown beside the sparkline. */
    readonly currentDelta: number;
    /** Pre-formatted error rate, or `—` when there is no traffic yet. */
    readonly errorRate: string;
    readonly history: ReadonlyArray<number>;
    /** p90/p95 derived from the snapshot's latency buckets. */
    readonly latencyPercentiles: { p90: number; p95: number };
    readonly metrics: ShardMetrics;
}): ReactElement => {
    const t = useT();

    return (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="mt-stats">
            <StatCard
                chart={
                    history.length >= 2 ? (
                        <Sparkline
                            ariaLabel={t("Requests per interval over time")}
                            className="h-7 w-24 text-foreground"
                            series={history}
                            testId="mt-sparkline"
                        />
                    ) : undefined
                }
                footer={
                    history.length >= 2 ? (
                        <>
                            <span className="font-semibold text-foreground">{`+${currentDelta.toLocaleString()}`}</span> {t("last interval")}
                        </>
                    ) : (
                        <span data-testid="mt-sparkline-empty">{t("collecting samples…")}</span>
                    )
                }
                label={t("Requests")}
                testId="mt-requests"
                value={metrics.requests}
            />
            <StatCard
                footer={t("{rate} error rate", { rate: errorRate })}
                label={t("Errors")}
                testId="mt-errors"
                value={
                    <>
                        {metrics.errors} ({errorRate})
                    </>
                }
            />
            <StatCard
                footer={latencyPercentiles.p90 > 0 ? `P90 ${formatLatency(latencyPercentiles.p90)}` : undefined}
                label={t("P95 latency")}
                testId="mt-p95"
                value={latencyPercentiles.p95 > 0 ? formatLatency(latencyPercentiles.p95) : "—"}
            />
            <StatCard
                footer={metrics.cache === null ? undefined : `${metrics.cache.entries.toLocaleString()} ${t("cache entries")}`}
                label={t("Database size")}
                testId="mt-db-size"
                value={formatBytes(metrics.databaseSize)}
            />
            <StatCard label={t("Shard")} testId="mt-shard" value={metrics.shard} />
            <StatCard label={t("Uptime")} testId="mt-uptime" value={formatElapsed(metrics.uptimeMs)} />
            <StatCard
                label={t("Cache hit rate")}
                testId="mt-cache"
                value={
                    metrics.cache === null
                        ? t("no cache configured")
                        : t("{rate} ({count} entries)", { count: metrics.cache.entries, rate: hitRate(metrics.cache.hits, metrics.cache.misses) })
                }
            />
        </dl>
    );
};

export { MetricsOverviewStats };
