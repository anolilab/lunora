import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { LogEntry, LogsResult, ShardMetrics } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import ConnectionBadge from "./connection-badge.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget, formatTimestamp } from "./internal.js";
import { loadRecentShards } from "./shard-history.js";

interface HealthPanelProps {
    /** Shard key the metric/log reads target on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_LOGS = adminRef(ADMIN_FUNCTIONS.getLogs);
const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Most recent error-level rows to show in the digest. */
const RECENT_ERROR_LIMIT = 5;

/** Error rate as a percentage string, or `—` when there's no traffic yet. */
const errorRate = (metrics: ShardMetrics | null): string => {
    if (metrics === null || metrics.requests === 0) {
        return "—";
    }

    return `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`;
};

/**
 * Read-only Health overview that aggregates the signals the dashboard can
 * already reach for a single shard instance. Connection shows the client's
 * aggregate live-socket status (via {@link ConnectionBadge}). Recent errors are
 * the error-level lines from the in-memory `__cirrus_admin__:getLogs` buffer (a
 * count plus the most recent few). The metrics summary surfaces request count
 * and error rate from the `__cirrus_admin__:getMetrics` snapshot. Shards seen
 * lists the recently-visited shard keys the dashboard remembers, since Durable
 * Objects can't be enumerated server-side.
 *
 * Both admin reads are best-effort: either may fail independently (a missing
 * `CIRRUS_ADMIN_TOKEN`, a cold instance) without blanking the rest of the
 * overview. This is a snapshot, not a live feed — press Refresh to re-pull.
 */
export const HealthPanel = ({ initialShardKey }: HealthPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [logsError, setLogsError] = useState<null | string>(null);
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [metricsError, setMetricsError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(false);

    // Recently-visited shard keys the dashboard remembers — read once on mount.
    const [recentShards] = useState<string[]>(loadRecentShards);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);

        const shard = initialShardKey ?? "";
        const [logs, snapshot] = await Promise.allSettled([
            client.query(GET_LOGS, {}, callOptions(shard)) as Promise<LogsResult>,
            client.query(GET_METRICS, {}, callOptions(shard)) as Promise<ShardMetrics>,
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

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-health">
            <div className="flex flex-wrap items-center gap-3">
                <ConnectionBadge />
                <Button data-testid="hl-refresh" disabled={loading} onClick={onRefresh} size="xs" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
            </div>

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
                            {errorRate(metrics)}
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
