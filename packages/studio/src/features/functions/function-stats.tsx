import { useCirrus } from "@cirrus/react";
import type { MouseEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useLiveAdmin from "../../hooks/use-live-admin";
import { useT } from "../../i18n/i18n-context";
import type { FunctionCallStat, FunctionStatsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, formatTimestamp } from "../../lib/internal";
import type { FunctionDescriptor, FunctionKind } from "../../lib/types";
import { cn } from "../../lib/utils";
import useLiveShardSeed from "../data/hooks/use-live-shard-seed";

interface FunctionStatsPanelProps {
    /** Descriptors from codegen, used to annotate each row with the function's `kind`. */
    readonly functions?: FunctionDescriptor[];
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** How the table is ordered. Mirrors the three questions an operator asks of this screen. */
type SortKey = "calls" | "recent" | "slowest";

const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);

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
 * message. Reads via the `__cirrus_admin__:getFunctionStats` RPC over the
 * {@link useCirrus} client; gated by the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * Counters are per-DO-instance and reset on hibernation/restart — this is a
 * "since this instance woke" readout, mirroring the metrics panel. The panel is
 * always live: a subscription opens once the first seed commits a shard and
 * re-pushes on every server write-flush so the table updates as mutations land.
 */
export const FunctionStatsPanel = ({ functions, initialShardKey }: FunctionStatsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [stats, setStats] = useState<FunctionCallStat[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [sortKey, setSortKey] = useState<SortKey>("recent");
    // Always-on live channel; this only holds a rejection message (e.g. missing
    // admin token) so the table can say why it stopped updating.
    const [liveError, setLiveError] = useState<string | undefined>(undefined);

    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Compile-time `kind` is phantom on FunctionReference, so the server can't
    // report it — annotate each row from the codegen descriptors by path.
    const kindByPath = useMemo<Map<string, FunctionKind>>(
        () => new Map((functions ?? []).map((descriptor) => [descriptor.path, descriptor.kind])),
        [functions],
    );

    const applyResult = useCallback(
        (result: FunctionStatsResult): void => {
            setError(null);
            setLiveError(undefined);
            setStats(result.functions);
        },
        [setLiveError],
    );

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            try {
                const next = (await client.query(GET_FUNCTION_STATS, {}, callOptions(shard))) as FunctionStatsResult;

                if (mountedRef.current) {
                    applyResult(next);
                }
            } catch (error_) {
                if (mountedRef.current) {
                    setStats(null);
                    setError(errorMessage(error_));
                }

                // Rethrow so the shard-seed hook doesn't commit a shard that failed.
                throw error_;
            }
        },
        [client, applyResult],
    );

    // Debounced shard seed + commit-on-success; the live channel keys on the
    // committed shard (replaces the old Refresh button).
    const committedShard = useLiveShardSeed(shardKey, refresh);

    useLiveAdmin(
        ADMIN_FUNCTIONS.getFunctionStats,
        {},
        committedShard ?? "",
        (next) => {
            if (mountedRef.current) {
                applyResult(next as FunctionStatsResult);
            }
        },
        committedShard !== undefined,
        (message) => {
            if (mountedRef.current) {
                setLiveError(message);
            }
        },
    );

    const selectSort = useCallback((event: MouseEvent<HTMLButtonElement>): void => {
        setSortKey(event.currentTarget.dataset.sort as SortKey);
    }, []);

    // Re-sort on the client so live pushes (and a changed sort mode) stay ordered
    // without a round-trip. `toSorted` leaves the source array immutable for React.
    const sorted = useMemo<FunctionCallStat[]>(() => (stats === null ? [] : stats.toSorted(SORTERS[sortKey])), [stats, sortKey]);

    const sortButtons: ReadonlyArray<{ key: SortKey; label: string }> = [
        { key: "recent", label: t("Recent") },
        { key: "calls", label: t("Most called") },
        { key: "slowest", label: t("Slowest") },
    ];

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-function-stats">
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

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="fs-error" role="alert">
                    {error}
                </p>
            )}

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
                                    <TableCell className={cn("text-right tabular-nums", stat.errors > 0 && "text-destructive")}>{errorCell(stat)}</TableCell>
                                    <TableCell className={cn("text-right tabular-nums", (stat.conflicts ?? 0) > 0 && "text-amber-600 dark:text-amber-500")}>
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
            )}
        </div>
    );
};

export type { FunctionStatsPanelProps };
