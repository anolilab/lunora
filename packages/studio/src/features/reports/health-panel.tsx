import type { SchedulerStatus } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import ConnectionBadge from "../../components/connection-badge";
import { LiveError } from "../../components/live-status";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { AuthMetrics, FunctionCallStat, LogEntry, LogsResult, MetricsSnapshot, MigrationStatusRow } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "../../lib/internal";
import { loadRecentShards } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import { shardsToAggregate } from "./metrics-aggregate";
import type { ShardSloResult, SloTotals } from "./slo-aggregate";
import { dedupeMigrations, mergeFunctionStats, sumShardMetrics } from "./slo-aggregate";
import { Sparkline } from "./sparkline";

interface HealthPanelProps {
    /** Shard key the metric/log reads target on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_AUTH_METRICS = adminRef(ADMIN_FUNCTIONS.getAuthMetrics);
const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);
const GET_LOGS = adminRef(ADMIN_FUNCTIONS.getLogs);
const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);
const MIGRATION_STATUS = adminRef(ADMIN_FUNCTIONS.migrationStatus);

/** Most recent error-level rows to show in the digest. */
const RECENT_ERROR_LIMIT = 5;

/** Minimum gap between live-driven cross-shard fan-outs, so a write burst can't hammer the worker. */
const MIN_FANOUT_INTERVAL_MS = 2000;

/** Functions shown in the "by error rate" list, worst first. */
const TOP_FUNCTION_LIMIT = 5;

/** SLO thresholds (fraction 0..1). Below `warn` is healthy; at/above `crit` is breaching. */
const REQUEST_ERROR_WARN = 0.01;
const REQUEST_ERROR_CRIT = 0.05;
// Auth failures tolerate a higher floor — users mistype passwords — so the bands are wider.
const AUTH_FAIL_WARN = 0.1;
const AUTH_FAIL_CRIT = 0.3;
// Scheduler backlog is an absolute job count, not a rate.
const BACKLOG_WARN = 1;
const BACKLOG_CRIT = 50;

type SloLevel = "crit" | "ok" | "warn";

/** Classify a 0..1 rate against its warn/crit thresholds. */
const rateLevel = (rate: number, warn: number, crit: number): SloLevel => {
    if (rate >= crit) {
        return "crit";
    }

    return rate >= warn ? "warn" : "ok";
};

/** Classify an absolute count (e.g. backlog) against warn/crit thresholds. `0` is always healthy. */
const countLevel = (count: number, warn: number, crit: number): SloLevel => {
    if (count >= crit) {
        return "crit";
    }

    return count >= warn ? "warn" : "ok";
};

/** Map an SLO level to a Badge variant, so a breach reads red at a glance. */
const LEVEL_VARIANT: Record<SloLevel, "default" | "destructive" | "secondary"> = {
    crit: "destructive",
    ok: "secondary",
    warn: "default",
};

/** A 0..1 rate as a percentage string, or `—` when the denominator is zero (no traffic yet). */
const ratePercent = (numerator: number, denominator: number): string => {
    if (denominator === 0) {
        return "—";
    }

    return `${((numerator / denominator) * 100).toFixed(1)}%`;
};

/**
 * Sum the per-function metric buckets into app-level request / error series,
 * ordered oldest-first, for the durable trend sparklines. Buckets arrive
 * per-`(path, bucketMs)`; collapsing on `bucketMs` gives the whole app's
 * requests-per-minute and errors-per-minute — the lunora-attributed view CF's
 * per-Worker charts can't produce.
 */
const requestErrorSeries = (history: MetricsSnapshot["history"]): { errors: number[]; requests: number[] } => {
    const byBucket = new Map<number, { calls: number; errors: number }>();

    for (const bucket of history ?? []) {
        const slot = byBucket.get(bucket.bucketMs) ?? { calls: 0, errors: 0 };

        slot.calls += bucket.calls;
        slot.errors += bucket.errors;
        byBucket.set(bucket.bucketMs, slot);
    }

    const ordered = [...byBucket.entries()].toSorted((a, b) => a[0] - b[0]);

    return {
        errors: ordered.map(([, slot]) => slot.errors),
        requests: ordered.map(([, slot]) => slot.calls),
    };
};

/** Roll up migration rows into a one-line status + an SLO level (any failed → crit, any running → warn). */
const migrationSummary = (rows: MigrationStatusRow[]): { failed: number; level: SloLevel; running: number } => {
    let failed = 0;
    let running = 0;

    for (const row of rows) {
        if (row.status === "failed") {
            failed += 1;
        } else if (row.status === "in_progress") {
            running += 1;
        }
    }

    let level: SloLevel = "ok";

    if (failed > 0) {
        level = "crit";
    } else if (running > 0) {
        level = "warn";
    }

    return { failed, level, running };
};

/** Render the migrations SLO tile's value: the failing/running count when there is one, else `OK`. */
const migrationTileValue = (summary: { failed: number; running: number }, t: TFunction): string => {
    if (summary.failed > 0) {
        return t("{count} failed", { count: summary.failed.toString() });
    }

    if (summary.running > 0) {
        return t("{count} running", { count: summary.running.toString() });
    }

    return t("OK");
};

/** Status-level → dot / value-text classes for the SLO cards and status banner. */
const LEVEL_DOT: Record<SloLevel, string> = { crit: "bg-destructive", ok: "bg-success", warn: "bg-warning" };
const LEVEL_TEXT: Record<SloLevel, string> = { crit: "text-destructive", ok: "text-foreground", warn: "text-warning" };
const LEVEL_RING: Record<SloLevel, string> = {
    crit: "bg-destructive/10 text-destructive",
    ok: "bg-success/10 text-success",
    warn: "bg-warning/10 text-warning",
};

/** Rank levels so the worst one wins for the overall health verdict. */
const worstLevel = (levels: ReadonlyArray<SloLevel>): SloLevel => {
    if (levels.includes("crit")) {
        return "crit";
    }

    return levels.includes("warn") ? "warn" : "ok";
};

/** One SLO as a KPI card: an uppercase label with a status dot, the status-coloured value, and an optional sparkline. */
const SloCard = ({
    chart,
    label,
    level,
    testId,
    value,
}: {
    chart?: ReactNode;
    label: string;
    level: SloLevel;
    testId: string;
    value: string;
}): ReactElement => (
    <Card className="gap-0 py-0">
        <div className="flex flex-col gap-2.5 p-4">
            <span className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[level])} />
                {label}
            </span>
            <div className="flex items-center justify-between gap-3">
                <span className={cn("truncate text-2xl font-semibold tabular-nums", LEVEL_TEXT[level])} data-testid={testId}>
                    {value}
                </span>
                {chart}
            </div>
        </div>
    </Card>
);

/** The composed, ready-to-render SLO model one cross-shard fetch resolves to. */
interface SloData {
    auth: AuthMetrics | null;
    entries: LogEntry[];
    functions: FunctionCallStat[];
    logsError: null | string;
    metricsError: null | string;
    migrations: MigrationStatusRow[];
    scheduler: SchedulerStatus | null;
    totals: SloTotals;
}

/**
 * Fan out the per-shard reads across `shards` and the global reads against the
 * root shard, then compose the app-level SLO model. Every read is best-effort: an
 * unreachable shard or a rejected signal degrades that part (empty / `—`) without
 * failing the pull. `metricsError` is set only when NOT one shard returned
 * metrics, carrying the root shard's reason.
 */
const loadSloData = async (client: ReturnType<typeof useLunora>, rootShard: string, shards: ReadonlyArray<string>): Promise<SloData> => {
    const perShardSettled = await Promise.all(
        shards.map((shard) => {
            const shardOptions = callOptions(shard);

            return Promise.allSettled([
                client.query(GET_METRICS, {}, shardOptions) as Promise<MetricsSnapshot>,
                client.query(GET_FUNCTION_STATS, {}, shardOptions) as Promise<{ functions: FunctionCallStat[] }>,
                client.query(MIGRATION_STATUS, {}, shardOptions) as Promise<{ migrations: MigrationStatusRow[] }>,
            ]);
        }),
    );

    const rootOptions = callOptions(rootShard);
    // `schedulerStatus` is a client method (not an admin RPC), absent on an older
    // client build, so guard it rather than let an undefined call throw.
    const schedulerStatus = typeof client.schedulerStatus === "function" ? client.schedulerStatus() : Promise.reject(new Error("scheduler status unavailable"));
    const [logs, authMetrics, schedulerState] = await Promise.allSettled([
        client.query(GET_LOGS, {}, rootOptions) as Promise<LogsResult>,
        client.query(GET_AUTH_METRICS, {}, rootOptions) as Promise<AuthMetrics>,
        schedulerStatus,
    ]);

    const perShard: ShardSloResult[] = perShardSettled.map(([m, f, mig]) => {
        return {
            functions: f.status === "fulfilled" ? f.value.functions : [],
            metrics: m.status === "fulfilled" ? m.value : null,
            migrations: mig.status === "fulfilled" ? mig.value.migrations : [],
        };
    });

    const totals = sumShardMetrics(perShard);
    const rootMetrics = perShardSettled[0]?.[0];

    return {
        auth: authMetrics.status === "fulfilled" ? authMetrics.value : null,
        entries: logs.status === "fulfilled" ? logs.value.entries : [],
        functions: mergeFunctionStats(perShard.map((shardResult) => shardResult.functions)),
        logsError: logs.status === "rejected" ? errorMessage(logs.reason) : null,
        metricsError: totals.reachable === 0 && rootMetrics?.status === "rejected" ? errorMessage(rootMetrics.reason) : null,
        migrations: dedupeMigrations(perShard.map((shardResult) => shardResult.migrations)),
        scheduler: schedulerState.status === "fulfilled" ? schedulerState.value : null,
        totals,
    };
};

/**
 * App-level health & SLO overview. On top of the original single-shard snapshot
 * (recent errors, request/error counts, shards seen) it composes the
 * lunora-attributed SLO signals the studio can already reach — app error
 * rate, auth-failure rate, scheduler backlog, and migration status — each with a
 * status badge, plus durable request/error and auth sparklines, and a
 * worst-first per-function error-rate list. None of this is CF's per-Worker
 * charting: it is attributed to lunora functions, the auth flow, and the
 * scheduler/migration subsystems.
 *
 * Every read is independent and best-effort (via `Promise.allSettled`): a
 * missing `LUNORA_ADMIN_TOKEN`, an unconfigured scheduler, or a cold instance
 * degrades that one tile to `—` without blanking the rest. The overview is always
 * live: a root-shard `getMetrics` subscription drives a full cross-shard re-pull
 * on every write-flush (coalesced so a burst yields at most one in-flight pull).
 */
/** Attempts and failures as parallel series for the auth sparkline. */
const authSeries = (auth: AuthMetrics | null | undefined): { attempts: number[]; failures: number[] } => {
    const buckets = auth?.history ?? [];

    return {
        attempts: buckets.map((bucket) => bucket.attempts),
        failures: buckets.map((bucket) => bucket.failures),
    };
};

export const HealthPanel = ({ initialShardKey }: HealthPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [logsError, setLogsError] = useState<null | string>(null);
    const [totals, setTotals] = useState<SloTotals | null>(null);
    const [metricsError, setMetricsError] = useState<null | string>(null);
    const [functions, setFunctions] = useState<FunctionCallStat[]>([]);
    const [auth, setAuth] = useState<AuthMetrics | null>(null);
    const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
    const [migrations, setMigrations] = useState<MigrationStatusRow[]>([]);

    // Recently-visited shard keys the studio remembers — read once on mount.
    const [recentShards] = useState<string[]>(loadRecentShards);

    // Guard against overlapping refreshes (a live push landing mid-fan-out) and
    // setState after unmount.
    const inFlightRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const rootShard = initialShardKey ?? "";

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: an effect and the fan-out timer depend on this, so a fresh one re-fires them every render
    const refresh = useCallback(async (): Promise<void> => {
        if (inFlightRef.current) {
            return;
        }

        inFlightRef.current = true;

        // Per-shard signals (metrics, function stats, migrations) sum across the
        // best-effort "shards we know about" set — DOs aren't enumerable, so it's
        // root + current + recently-visited. The global signals (logs buffer, auth
        // metrics, scheduler backlog) live on the root shard / worker, read once.
        const result = await loadSloData(client, rootShard, shardsToAggregate(rootShard, recentShards));

        if (!mountedRef.current) {
            inFlightRef.current = false;

            return;
        }

        setTotals(result.totals);
        setMetricsError(result.metricsError);
        setFunctions(result.functions);
        setMigrations(result.migrations);
        setEntries(result.entries);
        setLogsError(result.logsError);
        setAuth(result.auth);
        setScheduler(result.scheduler);

        inFlightRef.current = false;
    }, [client, recentShards, rootShard]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    // Cadence cap for the live fan-out: a cross-shard re-pull is expensive, so a
    // burst of write-flush pushes runs at most one fan-out per interval (leading +
    // one trailing), on top of the `inFlightRef` concurrency guard.
    const lastFanOutRef = useRef(0);
    const trailingTimerRef = useRef<null | ReturnType<typeof setTimeout>>(null);

    const scheduleFanOut = (): void => {
        const elapsed = Date.now() - lastFanOutRef.current;

        // Leading edge: enough time has passed, run immediately.
        if (elapsed >= MIN_FANOUT_INTERVAL_MS) {
            lastFanOutRef.current = Date.now();
            fireAndForget(refresh());

            return;
        }

        // Within the cooldown: coalesce the rest of the burst into one trailing run
        // at the interval edge (only if one isn't already scheduled).
        // An explicit `if`, not `??=`: React Compiler cannot lower `??=`, and one
        // unsupported operator bails the WHOLE component out of auto-memoization.
        // The ref is `null | Timeout`, so the two forms are equivalent, and the
        // compiler bail-out costs more than the extra line reads.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `??=` is unsupported by React Compiler's HIR lowering; see above
        if (trailingTimerRef.current === null) {
            trailingTimerRef.current = setTimeout(() => {
                trailingTimerRef.current = null;
                lastFanOutRef.current = Date.now();
                fireAndForget(refresh());
            }, MIN_FANOUT_INTERVAL_MS - elapsed);
        }
    };

    useEffect(
        () => () => {
            if (trailingTimerRef.current !== null) {
                clearTimeout(trailingTimerRef.current);
            }
        },
        [],
    );

    // Live channel: always on. A root-shard `getMetrics` subscription (re-pushed on
    // every write-flush) drives a cross-shard re-pull, rate-limited by
    // `scheduleFanOut` and the `inFlightRef` concurrency guard. `liveError` holds a
    // rejection message (e.g. missing admin token) so the overview can say why it
    // stopped updating; the one-shot seed `data` is otherwise unused here — its
    // only role is to tick `scheduleFanOut` when a fresh push lands.
    const { data: liveMetrics, liveError } = useAdminQuery<MetricsSnapshot>(ADMIN_FUNCTIONS.getMetrics, {}, { live: true, shardKey: rootShard });

    // Each fresh `getMetrics` push (one-shot seed or a live write-flush) schedules a
    // coalesced cross-shard fan-out. Folding a stream of pushes into the fan-out
    // cadence can only happen as each value lands, so this stays an effect.
    useEffect(() => {
        if (liveMetrics === undefined) {
            return;
        }

        scheduleFanOut();
        // `scheduleFanOut` reads only refs + the stable `refresh`; re-run per push.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the live push, not the (stable) scheduler closure.
    }, [liveMetrics]);

    // Entries arrive newest-first from the buffer.
    const recentErrors = entries.filter((entry) => entry.level === "error");
    const topErrors = recentErrors.slice(0, RECENT_ERROR_LIMIT);

    const trend = requestErrorSeries(totals?.history);
    const authTrend = authSeries(auth);

    // Functions that have run, worst error-rate first, then by call volume.
    const worstFunctions = functions
        .filter((stat) => stat.calls > 0)
        .toSorted((a, b) => b.errors / b.calls - a.errors / a.calls || b.calls - a.calls)
        .slice(0, TOP_FUNCTION_LIMIT);

    const migration = migrationSummary(migrations);

    const appErrorRate = totals === null || totals.requests === 0 ? 0 : totals.errors / totals.requests;
    const errorLevel = rateLevel(appErrorRate, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT);
    const authLevel = auth === null ? "ok" : rateLevel(auth.failureRate, AUTH_FAIL_WARN, AUTH_FAIL_CRIT);
    const backlogLevel: SloLevel = scheduler === null ? "ok" : countLevel(scheduler.backlog, BACKLOG_WARN, BACKLOG_CRIT);
    const overall = worstLevel([errorLevel, authLevel, backlogLevel, migration.level]);

    let statusLabel: string;
    let statusDescription: string;

    if (overall === "crit") {
        statusLabel = t("Critical");
        statusDescription = t("One or more service levels are breached.");
    } else if (overall === "warn") {
        statusLabel = t("Degraded");
        statusDescription = t("Some service levels need attention.");
    } else {
        statusLabel = t("All systems healthy");
        statusDescription = t("All service levels are within target.");
    }

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-health">
            {/* Overall status banner — the at-a-glance verdict plus headline throughput. */}
            <Card className="gap-0 py-0">
                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                    <div className="flex items-center gap-3">
                        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", LEVEL_RING[overall])}>
                            <span className={cn("size-3 rounded-full", LEVEL_DOT[overall])} />
                        </span>
                        <div className="grid leading-tight">
                            <span className="text-sm font-semibold text-foreground" data-testid="hl-status">
                                {statusLabel}
                            </span>
                            <span className="text-[13px] text-muted-foreground">{statusDescription}</span>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="text-end">
                            <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Requests")}</div>
                            <div className="flex items-center justify-end gap-2">
                                {trend.requests.length >= 2 && (
                                    <Sparkline
                                        ariaLabel={t("Requests over time")}
                                        className="h-6 w-20 text-foreground"
                                        series={trend.requests}
                                        testId="hl-spark-requests"
                                    />
                                )}
                                <span className="text-lg font-semibold tabular-nums text-foreground" data-testid="hl-requests">
                                    {(totals?.requests ?? 0).toString()}
                                </span>
                            </div>
                        </div>
                        <span aria-hidden="true" className="h-9 w-px bg-border" />
                        <div className="text-end">
                            <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Error rate")}</div>
                            <div className={cn("text-lg font-semibold tabular-nums", LEVEL_TEXT[errorLevel])} data-testid="hl-error-rate">
                                {totals === null ? "—" : ratePercent(totals.errors, totals.requests)}
                            </div>
                        </div>
                        <span aria-hidden="true" className="h-9 w-px bg-border" />
                        <div className="flex items-center gap-2">
                            <ConnectionBadge />
                            <LiveError message={liveError} prefix="hl" />
                        </div>
                    </div>
                </div>
                {metricsError !== null && (
                    <div className="border-t border-border bg-destructive/5 px-4 py-2 text-sm text-destructive" data-testid="hl-metrics-error" role="alert">
                        {metricsError}
                    </div>
                )}
            </Card>

            {/* Service-level KPIs — status-coloured, with trend sparklines. */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="hl-slo">
                <SloCard
                    chart={
                        trend.errors.length >= 2 ? (
                            <Sparkline ariaLabel={t("Errors over time")} className="h-7 w-20 text-destructive" series={trend.errors} testId="hl-spark-errors" />
                        ) : undefined
                    }
                    label={t("Error rate")}
                    level={errorLevel}
                    testId="hl-slo-errorrate"
                    value={totals === null ? "—" : ratePercent(totals.errors, totals.requests)}
                />
                <SloCard
                    chart={
                        authTrend.failures.length >= 2 ? (
                            <Sparkline
                                ariaLabel={t("Auth failures over time")}
                                className="h-7 w-20 text-destructive"
                                series={authTrend.failures}
                                testId="hl-spark-auth"
                            />
                        ) : undefined
                    }
                    label={t("Auth failures")}
                    level={authLevel}
                    testId="hl-slo-auth"
                    value={auth === null ? "—" : ratePercent(auth.failures, auth.attempts)}
                />
                <SloCard
                    label={t("Scheduler backlog")}
                    level={backlogLevel}
                    testId="hl-slo-backlog"
                    value={scheduler === null ? "—" : scheduler.backlog.toString()}
                />
                <SloCard label={t("Migrations")} level={migration.level} testId="hl-slo-migrations" value={migrationTileValue(migration, t)} />
            </div>

            {/* Functions by error rate + recent errors, side by side. */}
            <div className="grid gap-3 lg:grid-cols-2">
                <Card className="gap-0 py-0" data-testid="hl-functions">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Functions by error rate")}</span>
                    </header>
                    {worstFunctions.length === 0 ? (
                        <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="hl-functions-empty">
                            {t("No function activity yet.")}
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {worstFunctions.map((stat) => (
                                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs" data-testid="hl-fn-row" key={stat.path}>
                                    <span className="truncate font-mono text-foreground">{stat.path}</span>
                                    <span className="flex shrink-0 items-center gap-2">
                                        <span className="tabular-nums text-muted-foreground">{t("{count} calls", { count: stat.calls.toString() })}</span>
                                        <Badge variant={LEVEL_VARIANT[rateLevel(stat.errors / stat.calls, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)]}>
                                            {ratePercent(stat.errors, stat.calls)}
                                        </Badge>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                <Card className="gap-0 py-0">
                    <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Recent errors")}</span>
                        <Badge data-testid="hl-error-count" variant={recentErrors.length > 0 ? "destructive" : "outline"}>
                            {recentErrors.length}
                        </Badge>
                    </header>

                    {logsError !== null && (
                        <p className="px-4 py-8 text-center text-sm text-destructive" data-testid="hl-logs-error" role="alert">
                            {logsError}
                        </p>
                    )}

                    {logsError === null && topErrors.length === 0 && (
                        <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="hl-errors-empty">
                            {t("No recent errors.")}
                        </p>
                    )}

                    {topErrors.length > 0 && (
                        <ul className="divide-y divide-border">
                            {topErrors.map((entry, index) => (
                                <li
                                    className="flex flex-col gap-0.5 px-4 py-2 text-xs"
                                    data-testid="hl-error-row"
                                    key={`${entry.timestamp.toString()}-${index.toString()}`}
                                >
                                    <span className="flex items-center gap-2">
                                        <time className="shrink-0 text-muted-foreground">{formatTimestamp(entry.timestamp)}</time>
                                        {entry.functionPath !== undefined && <span className="truncate font-mono text-foreground">{entry.functionPath}</span>}
                                    </span>
                                    <span className="text-destructive">{entry.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>

            {/* Shards seen. */}
            <Card className="gap-0 py-0">
                <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Shards seen")}</span>
                    <Badge data-testid="hl-shard-count" variant="outline">
                        {recentShards.length}
                    </Badge>
                </header>
                {recentShards.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5 p-4">
                        {recentShards.map((shard) => (
                            <li data-testid="hl-shard" key={shard}>
                                <Badge variant="secondary">{shard}</Badge>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
};

export type { HealthPanelProps };
