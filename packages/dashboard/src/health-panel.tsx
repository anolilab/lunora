import type { SchedulerStatus } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthMetrics, FunctionCallStat, LogEntry, LogsResult, MetricsSnapshot, MigrationStatusRow } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import ConnectionBadge from "./connection-badge.js";
import type { TFunction } from "./i18n-context.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "./internal.js";
import { loadRecentShards } from "./shard-history.js";
import { Sparkline } from "./sparkline.js";

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
 * requests-per-minute and errors-per-minute — the cirrus-attributed view CF's
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

/** A labelled SLO tile: a value with a status-coloured badge. */
const SloTile = ({ label, level, testId, value }: { label: string; level: SloLevel; testId: string; value: string }): ReactElement => (
    <div className="flex min-w-24 flex-col gap-1 rounded-md border border-border p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Badge data-testid={testId} variant={LEVEL_VARIANT[level]}>
            {value}
        </Badge>
    </div>
);

/**
 * App-level health & SLO overview. On top of the original single-shard snapshot
 * (recent errors, request/error counts, shards seen) it composes the
 * cirrus-attributed SLO signals the dashboard can already reach — app error
 * rate, auth-failure rate, scheduler backlog, and migration status — each with a
 * status badge, plus durable request/error and auth sparklines, and a
 * worst-first per-function error-rate list. None of this is CF's per-Worker
 * charting: it is attributed to cirrus functions, the auth flow, and the
 * scheduler/migration subsystems.
 *
 * Every read is independent and best-effort (via `Promise.allSettled`): a
 * missing `CIRRUS_ADMIN_TOKEN`, an unconfigured scheduler, or a cold instance
 * degrades that one tile to `—` without blanking the rest. This is a snapshot,
 * not a live feed — press Refresh to re-pull.
 */
export const HealthPanel = ({ initialShardKey }: HealthPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [logsError, setLogsError] = useState<null | string>(null);
    const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
    const [metricsError, setMetricsError] = useState<null | string>(null);
    const [functions, setFunctions] = useState<FunctionCallStat[]>([]);
    const [auth, setAuth] = useState<AuthMetrics | null>(null);
    const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
    const [migrations, setMigrations] = useState<MigrationStatusRow[]>([]);
    const [loading, setLoading] = useState<boolean>(false);

    // Recently-visited shard keys the dashboard remembers — read once on mount.
    const [recentShards] = useState<string[]>(loadRecentShards);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);

        const shard = initialShardKey ?? "";
        const options = callOptions(shard);
        // `schedulerStatus` lives on the client (not an admin RPC) and is absent on
        // an older client build, so guard the call rather than let an undefined
        // method throw synchronously outside the settled batch.
        const schedulerStatus =
            typeof client.schedulerStatus === "function" ? client.schedulerStatus() : Promise.reject(new Error("scheduler status unavailable"));

        const [logs, snapshot, stats, authMetrics, migrationRows, schedulerState] = await Promise.allSettled([
            client.query(GET_LOGS, {}, options) as Promise<LogsResult>,
            client.query(GET_METRICS, {}, options) as Promise<MetricsSnapshot>,
            client.query(GET_FUNCTION_STATS, {}, options) as Promise<{ functions: FunctionCallStat[] }>,
            client.query(GET_AUTH_METRICS, {}, options) as Promise<AuthMetrics>,
            client.query(MIGRATION_STATUS, {}, options) as Promise<{ migrations: MigrationStatusRow[] }>,
            schedulerStatus,
        ]);

        if (logs.status === "fulfilled") {
            setEntries(logs.value.entries);
            setLogsError(null);
        } else {
            setLogsError(errorMessage(logs.reason));
        }

        if (snapshot.status === "fulfilled") {
            setMetrics(snapshot.value);
            setMetricsError(null);
        } else {
            setMetricsError(errorMessage(snapshot.reason));
        }

        // The SLO tiles degrade silently — a rejected read just leaves the tile at
        // its empty/`—` state rather than surfacing a banner per signal.
        setFunctions(stats.status === "fulfilled" ? stats.value.functions : []);
        setAuth(authMetrics.status === "fulfilled" ? authMetrics.value : null);
        setMigrations(migrationRows.status === "fulfilled" ? migrationRows.value.migrations : []);
        setScheduler(schedulerState.status === "fulfilled" ? schedulerState.value : null);

        setLoading(false);
    }, [client, initialShardKey]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    // Entries arrive newest-first from the buffer.
    const recentErrors = useMemo<LogEntry[]>(() => entries.filter((entry) => entry.level === "error"), [entries]);
    const topErrors = useMemo<LogEntry[]>(() => recentErrors.slice(0, RECENT_ERROR_LIMIT), [recentErrors]);

    const trend = useMemo(() => requestErrorSeries(metrics?.history), [metrics?.history]);
    const authTrend = useMemo(() => {
        const buckets = auth?.history ?? [];

        return {
            attempts: buckets.map((bucket) => bucket.attempts),
            failures: buckets.map((bucket) => bucket.failures),
        };
    }, [auth?.history]);

    // Functions that have run, worst error-rate first, then by call volume.
    const worstFunctions = useMemo<FunctionCallStat[]>(
        () =>
            functions
                .filter((stat) => stat.calls > 0)
                .toSorted((a, b) => b.errors / b.calls - a.errors / a.calls || b.calls - a.calls)
                .slice(0, TOP_FUNCTION_LIMIT),
        [functions],
    );

    const migration = useMemo(() => migrationSummary(migrations), [migrations]);

    const appErrorRate = metrics === null || metrics.requests === 0 ? 0 : metrics.errors / metrics.requests;
    const errorLevel = rateLevel(appErrorRate, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT);
    const authLevel = auth === null ? "ok" : rateLevel(auth.failureRate, AUTH_FAIL_WARN, AUTH_FAIL_CRIT);

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-health">
            <div className="flex flex-wrap items-center gap-3">
                <ConnectionBadge />
                <Button data-testid="hl-refresh" disabled={loading} onClick={onRefresh} size="xs" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
            </div>

            <section className="rounded-md border border-border p-3" data-testid="hl-slo">
                <h3 className="mb-2 text-sm font-semibold">{t("Service level")}</h3>
                <div className="flex flex-wrap gap-3">
                    <SloTile
                        label={t("Error rate")}
                        level={errorLevel}
                        testId="hl-slo-errorrate"
                        value={metrics === null ? "—" : ratePercent(metrics.errors, metrics.requests)}
                    />
                    <SloTile
                        label={t("Auth failures")}
                        level={authLevel}
                        testId="hl-slo-auth"
                        value={auth === null ? "—" : ratePercent(auth.failures, auth.attempts)}
                    />
                    <SloTile
                        label={t("Scheduler backlog")}
                        level={scheduler === null ? "ok" : countLevel(scheduler.backlog, BACKLOG_WARN, BACKLOG_CRIT)}
                        testId="hl-slo-backlog"
                        value={scheduler === null ? "—" : scheduler.backlog.toString()}
                    />
                    <SloTile label={t("Migrations")} level={migration.level} testId="hl-slo-migrations" value={migrationTileValue(migration, t)} />
                </div>

                <div className="mt-3 flex flex-wrap gap-6">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="hl-trend-requests">
                        <span>{t("Requests")}</span>
                        {trend.requests.length < 2 ? (
                            <span>{t("collecting samples…")}</span>
                        ) : (
                            <Sparkline ariaLabel={t("Requests over time")} className="text-primary" series={trend.requests} testId="hl-spark-requests" />
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="hl-trend-errors">
                        <span>{t("Errors")}</span>
                        {trend.errors.length < 2 ? (
                            <span>{t("collecting samples…")}</span>
                        ) : (
                            <Sparkline ariaLabel={t("Errors over time")} className="text-destructive" series={trend.errors} testId="hl-spark-errors" />
                        )}
                    </div>
                    {authTrend.failures.length >= 2 && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="hl-trend-auth">
                            <span>{t("Auth failures")}</span>
                            <Sparkline
                                ariaLabel={t("Auth failures over time")}
                                className="text-destructive"
                                series={authTrend.failures}
                                testId="hl-spark-auth"
                            />
                        </div>
                    )}
                </div>
            </section>

            <section className="rounded-md border border-border p-3" data-testid="hl-functions">
                <h3 className="mb-2 text-sm font-semibold">{t("Functions by error rate")}</h3>
                {worstFunctions.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="hl-functions-empty">
                        {t("No function activity yet.")}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {worstFunctions.map((stat) => (
                            <li className="flex flex-wrap items-baseline justify-between gap-2 text-xs" data-testid="hl-fn-row" key={stat.path}>
                                <span className="font-mono">{stat.path}</span>
                                <span className="flex items-center gap-2">
                                    <span className="text-muted-foreground">{t("{count} calls", { count: stat.calls.toString() })}</span>
                                    <Badge variant={LEVEL_VARIANT[rateLevel(stat.errors / stat.calls, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)]}>
                                        {ratePercent(stat.errors, stat.calls)}
                                    </Badge>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{t("Recent errors")}</h3>
                    <Badge data-testid="hl-error-count" variant={recentErrors.length > 0 ? "destructive" : "outline"}>
                        {recentErrors.length}
                    </Badge>
                </div>

                {logsError !== null && (
                    <p className="text-sm text-destructive" data-testid="hl-logs-error" role="alert">
                        {logsError}
                    </p>
                )}

                {logsError === null && topErrors.length === 0 && (
                    <p className="text-sm text-muted-foreground" data-testid="hl-errors-empty">
                        {t("No recent errors.")}
                    </p>
                )}

                {topErrors.length > 0 && (
                    <ul className="flex flex-col gap-1">
                        {topErrors.map((entry, index) => (
                            <li
                                className="flex flex-wrap items-baseline gap-2 text-xs"
                                data-testid="hl-error-row"
                                key={`${entry.timestamp.toString()}-${index.toString()}`}
                            >
                                <time className="text-muted-foreground">{formatTimestamp(entry.timestamp)}</time>
                                {entry.functionPath !== undefined && <span className="font-mono">{entry.functionPath}</span>}
                                <span className="text-destructive">{entry.message}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="rounded-md border border-border p-3">
                {metricsError !== null && (
                    <p className="text-sm text-destructive" data-testid="hl-metrics-error" role="alert">
                        {metricsError}
                    </p>
                )}

                <div className="flex flex-wrap gap-6">
                    <div>
                        <div className="text-xs text-muted-foreground">{t("Requests")}</div>
                        <div className="text-lg font-semibold" data-testid="hl-requests">
                            {(metrics?.requests ?? 0).toString()}
                        </div>
                    </div>
                    <div>
                        <div className="text-xs text-muted-foreground">{t("Errors")}</div>
                        <div className="text-lg font-semibold" data-testid="hl-error-rate">
                            {metrics === null ? "—" : ratePercent(metrics.errors, metrics.requests)}
                        </div>
                    </div>
                </div>
            </section>

            <section className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{t("Shards seen")}</h3>
                    <Badge data-testid="hl-shard-count" variant="outline">
                        {recentShards.length}
                    </Badge>
                </div>
                {recentShards.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                        {recentShards.map((shard) => (
                            <li data-testid="hl-shard" key={shard}>
                                <Badge variant="secondary">{shard}</Badge>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
};

export type { HealthPanelProps };
