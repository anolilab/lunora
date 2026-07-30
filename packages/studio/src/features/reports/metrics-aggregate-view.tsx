import type { ReactElement } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { formatBytes } from "../../lib/internal";
import type { AggregateMetrics, ShardMetricsResult } from "./metrics-aggregate";
import { StatCard } from "./stat-card";

/**
 * The cross-shard rollup: totals over every reachable shard, then the per-shard
 * table — an unreachable shard spans its columns with its error instead.
 *
 * Its own component because it answers a different question from the
 * single-shard readout beside it, over a different data shape, and only exists
 * once the operator has run a fan-out.
 */
const MetricsAggregateView = ({
    aggregate,
    shardResults,
}: {
    readonly aggregate: AggregateMetrics;
    readonly shardResults: ReadonlyArray<ShardMetricsResult>;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-4" data-testid="mt-aggregate-view">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="mt-aggregate-stats">
                <StatCard
                    label={t("Shards")}
                    testId="mt-agg-shards"
                    value={
                        aggregate.failed > 0
                            ? t("{reachable} reachable, {failed} unreachable", { failed: aggregate.failed, reachable: aggregate.reachable })
                            : t("{reachable} reachable", { reachable: aggregate.reachable })
                    }
                />
                <StatCard label={t("Total requests")} testId="mt-agg-requests" value={aggregate.totalRequests} />
                <StatCard label={t("Total errors")} testId="mt-agg-errors" value={aggregate.totalErrors} />
                <StatCard label={t("Total database size")} testId="mt-agg-db-size" value={formatBytes(aggregate.totalDatabaseSize)} />
                <StatCard
                    label={t("Combined cache hit rate")}
                    testId="mt-agg-cache"
                    value={aggregate.hitRate === null ? t("no cache configured") : `${(aggregate.hitRate * 100).toFixed(1)}%`}
                />
            </dl>

            <Card className="overflow-hidden py-0">
                <CardContent className="px-0">
                    <Table data-testid="mt-agg-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("shard")}</TableHead>
                                <TableHead>{t("requests")}</TableHead>
                                <TableHead>{t("errors")}</TableHead>
                                <TableHead>{t("db size")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shardResults.map((result) => (
                                <TableRow data-testid={`mt-agg-row-${result.shard}`} key={result.shard}>
                                    <TableCell>{result.shard}</TableCell>
                                    {result.metrics === null ? (
                                        <TableCell className="text-destructive" colSpan={3}>
                                            {result.error ?? t("unreachable")}
                                        </TableCell>
                                    ) : (
                                        <>
                                            <TableCell className="tabular-nums">{result.metrics.requests}</TableCell>
                                            <TableCell className="tabular-nums">{result.metrics.errors}</TableCell>
                                            <TableCell className="tabular-nums">{formatBytes(result.metrics.databaseSize)}</TableCell>
                                        </>
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export { MetricsAggregateView };
