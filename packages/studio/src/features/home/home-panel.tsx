import { useNavigate } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { lazy, Suspense } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { AuditEntry, FunctionCallStat, MetricsSnapshot, SecurityAuditResult, SubscriptionsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { fireAndForget, formatBytes } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { deriveInsights } from "../advisors/derive-insights";
import { BindingsOverview } from "./bindings-overview";
import { ConnectAgentCard } from "./connect-agent";

// The stat-card sparkline is Home's only `recharts` consumer. Lazy-loading it
// keeps the (heavy) chart engine out of the studio's entry bundle — Home's
// structure paints immediately and each sparkline streams in on its own chunk.
const Sparkline = lazy(() =>
    import("./sparkline").then((m) => {
        return { default: m.Sparkline };
    }),
);

interface HomePanelProps {
    /** Shard key the health digest targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** Format a millisecond duration compactly (`24ms`, `1.2s`). */
const formatMs = (ms: number): string => {
    if (ms < 1000) {
        return `${String(Math.round(ms))}ms`;
    }

    const digits = ms >= 10_000 ? 0 : 1;

    return `${(ms / 1000).toFixed(digits)}s`;
};

/** A coarse "2m ago" / "3h ago" relative time from an epoch-ms timestamp. */
const relativeTime = (ts: number, now: number): string => {
    const seconds = Math.max(0, Math.round((now - ts) / 1000));

    if (seconds < 60) {
        return `${String(seconds)}s ago`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${String(minutes)}m ago`;
    }

    const hours = Math.round(minutes / 60);

    return hours < 24 ? `${String(hours)}h ago` : `${String(Math.round(hours / 24))}d ago`;
};

/** A one-line "vs. previous window" change shown in a stat card's footer. */
interface StatDelta {
    readonly positive: boolean;
    readonly text: string;
}

/** Sum a metrics-history field per minute bucket, oldest first — the series a sparkline draws. */
const bucketSeries = (history: MetricsSnapshot["history"], field: "calls" | "errors"): number[] => {
    if (history === undefined || history.length === 0) {
        return [];
    }

    const byBucket = new Map<number, number>();

    for (const bucket of history) {
        byBucket.set(bucket.bucketMs, (byBucket.get(bucket.bucketMs) ?? 0) + bucket[field]);
    }

    return [...byBucket.entries()].toSorted(([a], [b]) => a - b).map(([, total]) => total);
};

/** Percent change of a series' recent half vs. its earlier half; null when not derivable. `higherIsBetter` colours the result. */
const seriesDelta = (series: number[], higherIsBetter = true): StatDelta | null => {
    if (series.length < 4) {
        return null;
    }

    const mid = Math.floor(series.length / 2);
    const earlier = series.slice(0, mid).reduce((sum, value) => sum + value, 0);
    const recent = series.slice(mid).reduce((sum, value) => sum + value, 0);

    if (earlier === 0) {
        return null;
    }

    const pct = ((recent - earlier) / earlier) * 100;

    return { positive: higherIsBetter ? pct >= 0 : pct <= 0, text: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` };
};

/**
 * One labelled health metric: an uppercase label, the value (with an optional
 * unit), an optional monochrome sparkline beside it, and a tinted footer band
 * carrying either a coloured delta or a neutral secondary stat — matching the
 * reference dashboard's stat-card anatomy.
 */
const StatCard = ({
    delta,
    footer,
    label,
    trend,
    unit,
    value,
}: {
    readonly delta?: StatDelta | null;
    readonly footer?: ReactNode;
    readonly label: string;
    readonly trend?: ReadonlyArray<number>;
    readonly unit?: string;
    readonly value: ReactNode;
}): ReactElement => {
    const t = useT();

    return (
        <Card className="justify-between gap-0 py-0">
            <div className="flex flex-col gap-2.5 p-4">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
                <div className="flex items-center justify-between gap-3">
                    <span className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
                        {unit !== undefined && <span className="text-xs text-muted-foreground">{unit}</span>}
                    </span>
                    {trend !== undefined && (
                        <Suspense fallback={<div aria-hidden="true" className="h-8 w-28" />}>
                            <Sparkline data={trend} />
                        </Suspense>
                    )}
                </div>
            </div>
            {delta == null ? (
                footer != null && <div className="border-t border-border bg-muted/50 px-4 py-2.5 text-[11px] text-muted-foreground">{footer}</div>
            ) : (
                <div className="border-t border-border bg-muted/50 px-4 py-2.5 text-[11px]">
                    <span className={cn("font-semibold", delta.positive ? "text-success" : "text-destructive")}>{delta.text}</span>{" "}
                    <span className="text-muted-foreground">{t("vs. prev.")}</span>
                </div>
            )}
        </Card>
    );
};

/** A small right-chevron used in the card footers' "View →" affordances. */
const ChevronRight = (): ReactElement => (
    <svg
        aria-hidden="true"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
    >
        <path d="m9 6 6 6-6 6" />
    </svg>
);

/** One "get connected" card: a method label up top, the command/import in the tinted footer band. */
const ConnectCard = ({ command, label }: { readonly command: string; readonly label: string }): ReactElement => (
    <Card className="justify-between gap-0 py-0">
        <div className="p-4">
            <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
        <div className="border-t border-border bg-muted/50 px-4 py-2.5">
            <code className="font-mono text-xs text-muted-foreground">{command}</code>
        </div>
    </Card>
);

interface AdvisorCardProps {
    readonly count: null | number;
    readonly onView: () => void;
    readonly testId: string;
    readonly title: string;
}

/**
 * One advisor summary card: a finding count up top with a "View" footer that
 * jumps to the advisor page. `null` count (the digest hasn't loaded, or the read
 * failed) renders a muted placeholder rather than a misleading zero.
 */
const AdvisorCard = ({ count, onView, testId, title }: AdvisorCardProps): ReactElement => {
    const t = useT();

    return (
        <Card className="justify-between gap-0 py-0" data-testid={testId}>
            <div className="flex items-start justify-between gap-2 p-4">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{title}</span>
                {count === null ? (
                    <span className="text-xs text-muted-foreground">{t("No data yet")}</span>
                ) : (
                    <Badge variant={count > 0 ? "destructive" : "success"}>{count > 0 ? count : t("All clear")}</Badge>
                )}
            </div>
            <button
                className="flex items-center gap-1 border-t border-border bg-muted/50 px-4 py-2.5 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
                onClick={onView}
                type="button"
            >
                {t("View")}
                <ChevronRight />
            </button>
        </Card>
    );
};

/** A leaderboard of the busiest functions (calls / avg latency / errors). */
const TopFunctionsCard = ({ functions }: { readonly functions: ReadonlyArray<FunctionCallStat> }): ReactElement => {
    const t = useT();
    const top = [...functions].toSorted((a, b) => b.calls - a.calls).slice(0, 5);

    return (
        <Card className="gap-0 py-0" data-testid="home-top-functions">
            <div className="border-b border-border px-4 py-3">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Top functions")}</span>
            </div>
            {top.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t("No functions called yet.")}</p>
            ) : (
                <div className="divide-y divide-border">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                        <span>{t("Function")}</span>
                        <span className="text-end">{t("Calls")}</span>
                        <span className="w-12 text-end">{t("Avg")}</span>
                        <span className="w-8 text-end">{t("Err")}</span>
                    </div>
                    {top.map((function_) => (
                        <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-4 py-2 text-[13px]" key={function_.path}>
                            <span className="truncate font-mono text-xs text-foreground">{function_.path}</span>
                            <span className="text-end tabular-nums">{function_.calls.toLocaleString()}</span>
                            <span className="w-12 text-end tabular-nums text-muted-foreground">
                                {formatMs(function_.calls > 0 ? function_.totalDurationMs / function_.calls : 0)}
                            </span>
                            <span className={cn("w-8 text-end tabular-nums", function_.errors > 0 ? "text-destructive" : "text-muted-foreground")}>
                                {function_.errors}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
};

/** Live real-time pulse: connected WebSockets and the subscriptions they track. */
const LiveConnectionsCard = ({ subs }: { readonly subs: SubscriptionsResult | null }): ReactElement => {
    const t = useT();

    return (
        <Card data-testid="home-live-connections">
            <CardContent className="flex flex-col gap-2.5 py-4">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Live connections")}</span>
                <span className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold tabular-nums text-foreground">{(subs?.totalConnections ?? 0).toLocaleString()}</span>
                    <span className="text-xs text-muted-foreground">{t("sockets")}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                    {(subs?.totalSubscriptions ?? 0).toLocaleString()} {t("active subscriptions")}
                </span>
            </CardContent>
        </Card>
    );
};

/** The latest durable admin operations (newest first). */
const RecentActivityCard = ({ entries }: { readonly entries: ReadonlyArray<AuditEntry> }): ReactElement => {
    const t = useT();
    // react-doctor-disable-next-line react-hooks-js/purity -- relative timestamps have to read the wall clock; the value is display-only and is meant to advance on every render
    const now = Date.now();

    return (
        <Card className="gap-0 py-0" data-testid="home-recent-activity">
            <div className="border-b border-border px-4 py-3">
                <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Recent activity")}</span>
            </div>
            {entries.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t("No recent activity.")}</p>
            ) : (
                <ul className="divide-y divide-border">
                    {entries.slice(0, 5).map((entry) => (
                        <li className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]" key={entry.seq}>
                            <span className="flex min-w-0 items-center gap-2">
                                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                                <span className="truncate text-foreground">
                                    {entry.op}
                                    {entry.table !== undefined && (
                                        <span className="text-muted-foreground">
                                            {" · "}
                                            {entry.table}
                                            {entry.id === undefined ? "" : `#${entry.id}`}
                                        </span>
                                    )}
                                </span>
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(entry.ts, now)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

/** Average handler latency across functions (total duration ÷ total calls). */
const averageLatencyMs = (functions: ReadonlyArray<FunctionCallStat>): null | number => {
    const calls = functions.reduce((sum, function_) => sum + function_.calls, 0);

    if (calls === 0) {
        return null;
    }

    return functions.reduce((sum, function_) => sum + function_.totalDurationMs, 0) / calls;
};

/**
 * The Home overview — the studio's landing page. It pulls the root shard's
 * health snapshot, the function stats, the two advisor signals, the live
 * subscription pulse, and the recent admin audit log, then presents an
 * at-a-glance digest: a KPI row (requests, errors, latency, database size), a
 * busiest-functions leaderboard, live connections, recent activity, the advisor
 * summary, and connect/quick-link shortcuts. Every read is best-effort — a
 * missing admin token or a cold instance leaves a card showing a muted
 * placeholder rather than blanking the page.
 */
export const HomePanel = ({ initialShardKey }: HomePanelProps): ReactElement => {
    const t = useT();
    const navigate = useNavigate();

    const shard = initialShardKey ?? "";

    // Each digest source is its own one-shot admin read, so a slow or failing card
    // (a missing admin token, a cold instance) degrades on its own rather than
    // blanking the page. The security audit is deployment-wide → root shard ("").
    const metricsQuery = useAdminQuery<MetricsSnapshot>(ADMIN_FUNCTIONS.getMetrics, {}, { shardKey: shard });
    const statsQuery = useAdminQuery<{ functions: FunctionCallStat[] }>(ADMIN_FUNCTIONS.getFunctionStats, {}, { shardKey: shard });
    const auditQuery = useAdminQuery<SecurityAuditResult>(ADMIN_FUNCTIONS.getSecurityAudit, {}, { shardKey: "" });
    const subscriptionsQuery = useAdminQuery<SubscriptionsResult>(ADMIN_FUNCTIONS.listSubscriptions, {}, { shardKey: shard });
    const auditLogQuery = useAdminQuery<{ entries: AuditEntry[] }>(ADMIN_FUNCTIONS.getAuditLog, {}, { shardKey: shard });

    const metrics = metricsQuery.data ?? null;
    const functions = Array.isArray(statsQuery.data?.functions) ? statsQuery.data.functions : [];
    const subscriptions = subscriptionsQuery.data ?? null;
    const activity = Array.isArray(auditLogQuery.data?.entries) ? auditLogQuery.data.entries : [];

    // `null` for an unresolved or failed read (renders a muted placeholder rather
    // than a misleading zero); a number once the read resolves. `deriveInsights`
    // draws on BOTH the metrics snapshot and the function stats, so wait for both —
    // resolving on `statsQuery` alone could show `0` / "No issues found" while the
    // metrics-derived insights are still loading.
    const performanceCount = metricsQuery.data === undefined || statsQuery.data === undefined ? null : deriveInsights(metrics, functions).length;
    const securityCount = Array.isArray(auditQuery.data?.findings) ? auditQuery.data.findings.length : null;

    const viewSecurity = (): void => {
        fireAndForget(navigate({ to: "/security" }));
    };

    const viewPerformance = (): void => {
        fireAndForget(navigate({ to: "/insights" }));
    };

    // Minute-bucketed request / error series from the durable metrics history,
    // drawn as the stat-card sparklines (empty until the snapshot resolves, or on
    // a worker that predates the history feed).
    const requestSeries = bucketSeries(metrics?.history, "calls");
    const errorSeries = bucketSeries(metrics?.history, "errors");
    const avgLatency = averageLatencyMs(functions);
    const maxLatency = Math.max(0, ...functions.map((function_) => function_.maxDurationMs));
    const cache = metrics?.cache;
    const cacheHitRate = cache != null && cache.hits + cache.misses > 0 ? Math.round((cache.hits / (cache.hits + cache.misses)) * 100) : null;

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-home">
            {/* KPI row. */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="home-health">
                <StatCard delta={seriesDelta(requestSeries)} label={t("Requests")} trend={requestSeries} value={(metrics?.requests ?? 0).toLocaleString()} />
                <StatCard delta={seriesDelta(errorSeries, false)} label={t("Errors")} trend={errorSeries} value={(metrics?.errors ?? 0).toLocaleString()} />
                <StatCard
                    footer={maxLatency > 0 ? `${t("max")} ${formatMs(maxLatency)}` : undefined}
                    label={t("Avg latency")}
                    value={avgLatency === null ? "—" : formatMs(avgLatency)}
                />
                <StatCard
                    footer={cacheHitRate === null ? undefined : `${String(cacheHitRate)}% ${t("cache hit")}`}
                    label={t("Database size")}
                    value={formatBytes(metrics?.databaseSize ?? null)}
                />
            </div>

            {/* Cloudflare bindings the app wires (KV / R2 / Vectorize) — count + names. */}
            <BindingsOverview />

            {/* Activity: busiest functions, live connections, recent changes. */}
            <div className="grid gap-3 lg:grid-cols-3">
                <div className="lg:col-span-2">
                    <TopFunctionsCard functions={functions} />
                </div>
                <div className="flex flex-col gap-3">
                    <LiveConnectionsCard subs={subscriptions} />
                    <RecentActivityCard entries={activity} />
                </div>
            </div>

            {/* Advisors summary. When both advisors are loaded and clean, collapse
                to a single "no issues" state. */}
            <section className="flex flex-col gap-3" data-testid="home-advisors">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("Advisors")}</h2>
                {securityCount === 0 && performanceCount === 0 ? (
                    <EmptyState
                        description={t("No security or performance issues detected.")}
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
                                <path d="M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3Z" />
                                <path d="m9 12 2 2 4-4" />
                            </svg>
                        }
                        testId="home-advisors-clear"
                        title={t("No issues found")}
                    />
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <AdvisorCard count={securityCount} onView={viewSecurity} testId="home-security" title={t("Security findings")} />
                        <AdvisorCard count={performanceCount} onView={viewPerformance} testId="home-performance" title={t("Performance issues")} />
                    </div>
                )}
            </section>

            {/* Get connected — point an app at this deployment. */}
            <section className="flex flex-col gap-3" data-testid="home-get-connected">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("Get connected")}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                    <ConnectCard command="npm i @lunora/client" label={t("Client SDK")} />
                    <ConnectCard command="npm i @lunora/react" label={t("React")} />
                    <ConnectCard command="lunora dev" label={t("CLI")} />
                </div>
                <ConnectAgentCard />
            </section>
        </div>
    );
};

export type { HomePanelProps };
