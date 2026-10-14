import type { MouseEvent, ReactElement } from "react";
import { useState } from "react";

import ErrorAlert from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { FunctionCallStat, FunctionStatsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import type { FunctionDescriptor, FunctionKind } from "../../lib/types";
import { cn } from "../../lib/utils";

interface FunctionStatsPanelProps {
    /** Descriptors from codegen, used to annotate each row with the function's `kind`. */
    readonly functions?: FunctionDescriptor[];
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** How the table is ordered. Mirrors the three questions an operator asks of this screen. */
type SortKey = "calls" | "recent" | "slowest";

/** Map a function `kind` to the same Badge variant the runner uses, so colours stay consistent across the Functions tab. */
const KIND_VARIANT: Record<FunctionKind, "default" | "outline" | "secondary"> = {
    action: "outline",
    mutation: "default",
    query: "secondary",
};

/** Render a handler duration with ms precision under a second, switching to seconds above it. */
const formatMs = (ms: number): string => {
    if (ms < 1000) {
        return `${ms < 10 ? ms.toFixed(1) : Math.round(ms).toString()}ms`;
    }

    return `${(ms / 1000).toFixed(2)}s`;
};

/** Error count plus its rate, or just the count when nothing has failed. `—` when the function never ran. */
const errorCell = (stat: FunctionCallStat): string => {
    if (stat.calls === 0) {
        return "—";
    }

    if (stat.errors === 0) {
        return "0";
    }

    return `${stat.errors.toString()} (${((stat.errors / stat.calls) * 100).toFixed(1)}%)`;
};

/**
 * OCC write-conflict count plus its rate, mirroring {@link errorCell}. Conflicts
 * are a subset of errors (a retryable optimistic-concurrency miss), so this
 * column isolates write contention from the broader error column. `conflicts` is
 * absent on a pre-conflict-tracking worker, so it defaults to 0.
 */
const conflictCell = (stat: FunctionCallStat): string => {
    const conflicts = stat.conflicts ?? 0;

    if (stat.calls === 0) {
        return "—";
    }

    if (conflicts === 0) {
        return "0";
    }

    return `${conflicts.toString()} (${((conflicts / stat.calls) * 100).toFixed(1)}%)`;
};

/** Stable comparators per sort mode; the server already returns recent-first, but re-sorting keeps live pushes ordered too. */
const SORTERS: Record<SortKey, (a: FunctionCallStat, b: FunctionCallStat) => number> = {
    calls: (a, b) => b.calls - a.calls,
    recent: (a, b) => b.lastCalledAt - a.lastCalledAt,
    slowest: (a, b) => b.maxDurationMs - a.maxDurationMs,
};

/**
 * Per-function execution metrics for one shard: call count, error count/rate,
 * mean and slowest handler latency, last-run time, and the most recent error
 * message. Reads via the `__lunora_admin__:getFunctionStats` RPC through
 * `useAdminQuery`; gated by the server's `LUNORA_ADMIN_TOKEN`.
 *
 * Counters are per-DO-instance and reset on hibernation/restart — this is a
 * "since this instance woke" readout, mirroring the metrics panel. The panel is
 * always live: `useAdminQuery`'s `live` subscription re-pushes on every server
 * write-flush so the table updates as mutations land.
 */
export const FunctionStatsPanel = ({ functions, initialShardKey }: FunctionStatsPanelProps): ReactElement => {
    const t = useT();

    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    const [sortKey, setSortKey] = useState<SortKey>("recent");

    // One-shot read + always-on live subscription for the committed shard. Each
    // server push updates the table as mutations land; `liveError` holds a
    // rejection message (e.g. missing admin token) so the table can say why it
    // stopped updating.
    const { data, error, errorSource, liveError } = useAdminQuery<FunctionStatsResult>(
        ADMIN_FUNCTIONS.getFunctionStats,
        {},
        {
            live: true,
            shardKey: queryShardKey,
        },
    );

    const stats = data?.functions ?? null;

    // Compile-time `kind` is phantom on FunctionReference, so the server can't
    // report it — annotate each row from the codegen descriptors by path.
    const kindByPath = new Map((functions ?? []).map((descriptor) => [descriptor.path, descriptor.kind]));

    const selectSort = (event: MouseEvent<HTMLButtonElement>): void => {
        setSortKey(event.currentTarget.dataset.sort as SortKey);
    };

    // Re-sort on the client so live pushes (and a changed sort mode) stay ordered
    // without a round-trip. `toSorted` leaves the source array immutable for React.
    const sorted = stats === null ? [] : stats.toSorted(SORTERS[sortKey]);

    const sortButtons: ReadonlyArray<{ key: SortKey; label: string }> = [
        { key: "recent", label: t("Recent") },
        { key: "calls", label: t("Most called") },
        { key: "slowest", label: t("Slowest") },
    ];

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-function-stats">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="fs-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="fs" />
                <div className="ml-auto flex items-center gap-1" role="group">
                    {sortButtons.map((option) => (
                        <Button
                            data-sort={option.key}
                            data-testid={`fs-sort-${option.key}`}
                            key={option.key}
                            onClick={selectSort}
                            size="sm"
                            type="button"
                            variant={sortKey === option.key ? "secondary" : "ghost"}
                        >
                            {option.label}
                        </Button>
                    ))}
                </div>
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="fs-error" />}

            {stats !== null && sorted.length === 0 && error === null && (
                <EmptyState
                    description={t("Per-function call counts, error rates, and latency land here after your first request.")}
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
                            <path d="M3 3v18h18" />
                            <path d="M7 14l4-4 3 3 5-6" />
                        </svg>
                    }
                    testId="fs-empty"
                    title={t("No functions have run on this shard yet.")}
                />
            )}

            {sorted.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="fs-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("function")}</TableHead>
                                    <TableHead>{t("kind")}</TableHead>
                                    <TableHead className="text-right">{t("calls")}</TableHead>
                                    <TableHead className="text-right">{t("errors")}</TableHead>
                                    <TableHead className="text-right">{t("conflicts")}</TableHead>
                                    <TableHead className="text-right">{t("avg")}</TableHead>
                                    <TableHead className="text-right">{t("max")}</TableHead>
                                    <TableHead>{t("last run")}</TableHead>
                                    <TableHead>{t("last error")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sorted.map((stat) => {
                                    const kind = kindByPath.get(stat.path);

                                    return (
                                        <TableRow data-testid={`fs-row-${stat.path}`} key={stat.path}>
                                            <TableCell className="font-medium">{stat.path}</TableCell>
                                            <TableCell>
                                                {kind === undefined ? (
                                                    <span className="text-muted-foreground">—</span>
                                                ) : (
                                                    <Badge variant={KIND_VARIANT[kind]}>{kind}</Badge>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">{stat.calls}</TableCell>
                                            <TableCell className={cn("text-right tabular-nums", stat.errors > 0 && "text-destructive")}>
                                                {errorCell(stat)}
                                            </TableCell>
                                            <TableCell className={cn("text-right tabular-nums", (stat.conflicts ?? 0) > 0 && "text-warning")}>
                                                {conflictCell(stat)}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">
                                                {stat.calls === 0 ? "—" : formatMs(stat.totalDurationMs / stat.calls)}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">{stat.calls === 0 ? "—" : formatMs(stat.maxDurationMs)}</TableCell>
                                            <TableCell className="text-muted-foreground">{formatTimestamp(stat.lastCalledAt, "—")}</TableCell>
                                            <TableCell className="max-w-[24ch] truncate text-destructive" title={stat.lastErrorMessage ?? undefined}>
                                                {stat.lastErrorMessage ?? <span className="text-muted-foreground">—</span>}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { FunctionStatsPanelProps };
