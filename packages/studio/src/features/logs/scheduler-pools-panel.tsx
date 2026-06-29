import type { SchedulerStatus } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";

interface SchedulerPoolsPanelProps {
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
 */
export const SchedulerPoolsPanel = ({ loadStatus }: SchedulerPoolsPanelProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    // The scheduler status is HTTP-only (no admin-RPC path), so it's a
    // `useClientQuery` over the supplied loader (or `client.schedulerStatus`).
    // Most-backed-up pools first so the saturated ones surface at the top.
    const statusQuery = useClientQuery(["lunora-scheduler-status", loadStatus === undefined], async () => {
        const next = await (loadStatus ?? (() => client.schedulerStatus()))();

        return { ...next, pools: next.pools.toSorted((a, b) => b.queued - a.queued) };
    });
    const { data: status, error } = statusQuery;

    useAutoRefresh(() => {
        statusQuery.refetch();
    }, true);

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
