import type { SchedulerStatus } from "@lunora/client";
import type { ReactElement } from "react";

import { ShardInput } from "../../components/shard-input";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery, useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useShardKey } from "../../hooks/use-shard-key";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import type { MetricSeries, MetricSeriesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { errorCode } from "../../lib/internal";

/** The histogram the shard records per scheduled job: due time to dispatch, in ms. */
const LAG_METRIC = "scheduler.lag_ms";

/** The job a lag series is for — the shard keys each job's series by a `function` attribute. */
const lagFunction = (series: MetricSeries): string => {
    const name = series.attributes?.["function"];

    return typeof name === "string" ? name : series.functionPath;
};

interface SchedulerPoolsPanelProps {
    /** The shard whose lag series to show first. Defaults to the default shard. */
    readonly initialShardKey?: string;
    /** Load the workpool backlog status. Defaults to `client.schedulerStatus`. */
    readonly loadStatus?: () => Promise<SchedulerStatus>;
}

/** A headline metric tile — one number with a label. */
const StatTile = ({ label, testId, value }: { label: string; testId: string; value: number }): ReactElement => (
    <Card className="flex-1 py-0">
        <CardContent className="flex flex-col gap-1 p-4">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-2xl font-semibold tabular-nums" data-testid={testId}>
                {value}
            </span>
        </CardContent>
    </Card>
);

/**
 * The workpool backlog / concurrency view. Reads the SchedulerDO's `GET /status`
 * (per-pool `{ queued, inFlight, maxConcurrency }` plus app-wide `backlog` and
 * `inFlight` totals) so an operator can see saturation and queue depth at a
 * glance — the closest Lunora analogue to Cloudflare Queues' backlog metrics,
 * which don't cover the SchedulerDO. Polls on the shared auto-refresh interval.
 * Below the totals, each job's start lag (due time to dispatch) from the
 * shard's `scheduler.lag_ms` series — a lag that climbs is a queue falling behind.
 */
export const SchedulerPoolsPanel = ({ initialShardKey, loadStatus }: SchedulerPoolsPanelProps = {}): ReactElement => {
    const client = useStudioClient();
    const t = useT();

    // The scheduler status is HTTP-only (no admin-RPC path), so it's a
    // `useClientQuery` over the supplied loader (or `client.schedulerStatus`).
    // Most-backed-up pools first so the saturated ones surface at the top.
    const statusQuery = useClientQuery(["lunora-scheduler-status", loadStatus === undefined], async () => {
        const next = await (loadStatus ?? (() => client.schedulerStatus()))();

        return { ...next, pools: next.pools.toSorted((a, b) => b.queued - a.queued) };
    });
    const { data: status, error } = statusQuery;

    // The shard records a job's lateness when it runs it, so lag lives in that
    // shard's metric series rather than in the SchedulerDO's backlog status — and
    // only on the shard the job targets. Polled, not live: recording a sample
    // writes no table, so a live subscription would never re-run for it.
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    const metricsQuery = useAdminQuery<MetricSeriesResult>(ADMIN_FUNCTIONS.getMetricSeries, {}, { shardKey: queryShardKey });
    const { data: metrics, errorSource: metricsErrorSource } = metricsQuery;
    // A worker predating `getMetricSeries` answers FUNCTION_NOT_FOUND: no lag data
    // to show, not a failure — the Instruments table treats it the same way.
    const metricsError = errorCode(metricsErrorSource) === "FUNCTION_NOT_FOUND" ? null : metricsQuery.error;

    // Separate timers: each poll backs off or stops on its own failures, so a
    // shard the token cannot read must not freeze the pool status, or the reverse.
    useAutoRefresh(() => statusQuery.poll(), true);
    useAutoRefresh(() => metricsQuery.poll(), true);

    const lag = (Array.isArray(metrics?.series) ? metrics.series : [])
        .filter((series) => series.name === LAG_METRIC && series.count > 0)
        .toSorted((a, b) => b.max - a.max);

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-scheduler-pools">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="pools-error" role="alert">
                    {error}
                </p>
            )}

            {status !== undefined && (
                <div className="flex gap-3" data-testid="pools-totals">
                    <StatTile label={t("backlog")} testId="pools-backlog" value={status.backlog} />
                    <StatTile label={t("in flight")} testId="pools-inflight" value={status.inFlight} />
                    <StatTile label={t("pools")} testId="pools-count" value={status.pools.length} />
                </div>
            )}

            {status?.pools.length === 0 && (
                <EmptyState
                    description={t("Pools created with createWorkpool appear here once they have activity.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 7h16M4 12h16M4 17h16" />
                        </svg>
                    }
                    testId="pools-empty"
                    title={t("No workpools.")}
                />
            )}

            <div className="flex flex-wrap items-center gap-3">
                <ShardInput onChange={setShardKey} testId="lag-shard-input" value={shardKey} />
                <p className="text-xs text-muted-foreground" data-testid="lag-scope">
                    {t("Start lag per job on this shard since it last woke; the series reset when the shard hibernates.")}
                </p>
            </div>

            {metricsError !== null && (
                <p className="text-sm text-destructive" data-testid="lag-error" role="alert">
                    {metricsError}
                </p>
            )}

            {metricsError === null && lag.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="lag-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("runs")}</TableHead>
                                    <TableHead>{t("mean lag (ms)")}</TableHead>
                                    <TableHead>{t("max lag (ms)")}</TableHead>
                                    <TableHead>{t("last lag (ms)")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {lag.map((series) => (
                                    <TableRow data-testid={`lag-row-${lagFunction(series)}`} key={lagFunction(series)}>
                                        <TableCell className="font-mono text-xs">{lagFunction(series)}</TableCell>
                                        <TableCell className="tabular-nums">{series.count}</TableCell>
                                        <TableCell className="tabular-nums">{Math.round(series.sum / series.count)}</TableCell>
                                        <TableCell className="tabular-nums">{series.max}</TableCell>
                                        <TableCell className="tabular-nums">{series.last}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {status !== undefined && status.pools.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="pools-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("pool")}</TableHead>
                                    <TableHead>{t("queued")}</TableHead>
                                    <TableHead>{t("in flight")}</TableHead>
                                    <TableHead>{t("max concurrency")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {status.pools.map((pool) => (
                                    <TableRow data-testid={`pools-row-${pool.name}`} key={pool.name}>
                                        <TableCell className="font-mono text-xs">{pool.name}</TableCell>
                                        <TableCell className="tabular-nums">{pool.queued}</TableCell>
                                        <TableCell className="tabular-nums">
                                            {pool.inFlight} / {pool.maxConcurrency}
                                        </TableCell>
                                        <TableCell className="tabular-nums">{pool.maxConcurrency}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { SchedulerPoolsPanelProps };
