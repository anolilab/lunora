import { useCirrus } from "@cirrus/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import type { FunctionStatsResult, SecurityAuditResult, ShardMetrics } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { EmptyState } from "./components/ui/empty-state";
import { deriveInsights } from "./derive-insights";
import { useT } from "./i18n-context";
import { adminRef, callOptions, fireAndForget, formatBytes } from "./internal";

interface HomePanelProps {
    /** Shard key the health digest targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);
const GET_FUNCTION_STATS = adminRef(ADMIN_FUNCTIONS.getFunctionStats);
const GET_SECURITY_AUDIT = adminRef(ADMIN_FUNCTIONS.getSecurityAudit);

/** One labelled health metric in the digest row. */
const StatCard = ({ label, value }: { readonly label: string; readonly value: ReactNode }): ReactElement => (
    <Card className="rounded-md">
        <CardContent className="flex flex-col gap-1 py-4">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
            <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        </CardContent>
    </Card>
);

/** One "get connected" card: a method label + the command/import that wires it up. */
const ConnectCard = ({ command, label }: { readonly command: string; readonly label: string }): ReactElement => (
    <Card className="rounded-md">
        <CardContent className="flex flex-col gap-2 py-4">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{command}</code>
        </CardContent>
    </Card>
);

interface AdvisorCardProps {
    readonly count: null | number;
    readonly onView: () => void;
    readonly testId: string;
    readonly title: string;
}

/**
 * One advisor summary card: a finding count with a jump to the advisor page.
 * `null` count (the digest hasn't loaded, or the read failed) renders a muted
 * placeholder rather than a misleading zero.
 */
const AdvisorCard = ({ count, onView, testId, title }: AdvisorCardProps): ReactElement => {
    const t = useT();

    return (
        <Card className="rounded-md" data-testid={testId}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
                {count === null ? (
                    <span className="text-xs text-muted-foreground">{t("No data yet")}</span>
                ) : (
                    <Badge variant={count > 0 ? "destructive" : "outline"}>{count > 0 ? count : t("All clear")}</Badge>
                )}
            </CardHeader>
            <CardContent>
                <Button onClick={onView} size="sm" type="button" variant="outline">
                    {t("View")}
                </Button>
            </CardContent>
        </Card>
    );
};

/**
 * The Home overview — the studio's landing page, modelled on Supabase Studio's
 * Home (`STUDIO-REDESIGN-PLAN.md` §2). It pulls the root shard's health snapshot
 * plus the two advisor signals and presents an at-a-glance digest: request/error
 * counts and database size, a security- and performance-findings summary that
 * deep-links into the Advisors section, and quick links into the busiest panels.
 * Every read is best-effort — a missing admin token or a cold instance leaves a
 * card showing a muted placeholder rather than blanking the page.
 */
export const HomePanel = ({ initialShardKey }: HomePanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();
    const navigate = useNavigate();

    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [performanceCount, setPerformanceCount] = useState<null | number>(null);
    const [securityCount, setSecurityCount] = useState<null | number>(null);

    useEffect(() => {
        const shard = initialShardKey ?? "";

        const load = async (): Promise<void> => {
            const [snapshot, stats, audit] = await Promise.allSettled([
                client.query(GET_METRICS, {}, callOptions(shard)) as Promise<ShardMetrics>,
                client.query(GET_FUNCTION_STATS, {}, callOptions(shard)) as Promise<FunctionStatsResult>,
                client.query(GET_SECURITY_AUDIT, {}, callOptions("")) as Promise<SecurityAuditResult>,
            ]);

            const snapshotValue = snapshot.status === "fulfilled" ? snapshot.value : null;

            setMetrics(snapshotValue);
            setPerformanceCount(stats.status === "fulfilled" ? deriveInsights(snapshotValue, stats.value.functions).length : null);
            setSecurityCount(audit.status === "fulfilled" && Array.isArray(audit.value.findings) ? audit.value.findings.length : null);
        };

        fireAndForget(load());
    }, [client, initialShardKey]);

    const goTo = useCallback(
        (event: React.MouseEvent<HTMLButtonElement>): void => {
            fireAndForget(navigate({ to: event.currentTarget.dataset.to ?? "/home" }));
        },
        [navigate],
    );

    const viewSecurity = useCallback((): void => {
        fireAndForget(navigate({ to: "/security" }));
    }, [navigate]);

    const viewPerformance = useCallback((): void => {
        fireAndForget(navigate({ to: "/insights" }));
    }, [navigate]);

    return (
        <div className="flex flex-col gap-6" data-testid="cirrus-home">
            {/* Health digest. */}
            <div className="grid gap-3 sm:grid-cols-3" data-testid="home-health">
                <StatCard label={t("Requests")} value={(metrics?.requests ?? 0).toLocaleString()} />
                <StatCard label={t("Errors")} value={(metrics?.errors ?? 0).toLocaleString()} />
                <StatCard label={t("Database size")} value={formatBytes(metrics?.databaseSize ?? null)} />
            </div>

            {/* Advisors summary. When both advisors are loaded and clean, collapse
                to a single "no issues" state (mirrors Supabase's Home advisor block). */}
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

            {/* Get connected — point an app at this deployment (Supabase-style). */}
            <section className="flex flex-col gap-3" data-testid="home-get-connected">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("Get connected")}</h2>
                <div className="grid gap-3 sm:grid-cols-3">
                    <ConnectCard command="npm i @cirrus/client" label={t("Client SDK")} />
                    <ConnectCard command="npm i @cirrus/react" label={t("React")} />
                    <ConnectCard command="cirrus dev" label={t("CLI")} />
                </div>
            </section>

            {/* Quick links into the busiest panels. */}
            <section className="flex flex-col gap-3" data-testid="home-quick-links">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">{t("Quick links")}</h2>
                <div className="flex flex-wrap gap-2">
                    <Button data-to="/data" onClick={goTo} size="sm" type="button" variant="outline">
                        {t("Table editor")}
                    </Button>
                    <Button data-to="/functions" onClick={goTo} size="sm" type="button" variant="outline">
                        {t("SQL / Functions")}
                    </Button>
                    <Button data-to="/logs" onClick={goTo} size="sm" type="button" variant="outline">
                        {t("Logs")}
                    </Button>
                </div>
            </section>
        </div>
    );
};

export type { HomePanelProps };
