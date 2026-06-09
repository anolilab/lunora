import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { SecurityAuditResult, SecurityFinding, SecurityFindingLevel } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { EmptyState } from "./components/ui/empty-state";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";

const GET_SECURITY_AUDIT = adminRef(ADMIN_FUNCTIONS.getSecurityAudit);

/** Badge variant per finding level — shared with the Performance Advisor (Insights). */
const LEVEL_VARIANT: Record<SecurityFindingLevel, "default" | "destructive" | "secondary"> = {
    error: "destructive",
    info: "secondary",
    warning: "default",
};

/** Localized headline per finding kind; presentation stays out of the server payload. */
const findingTitle = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Weak admin token"),
        "dev-args-unredacted": t("Request log keeps un-redacted args"),
        "ws-gate-open": t("Live admin subscriptions are ungated"),
    })[finding.kind];

/** Localized one-line explanation + remediation per finding kind. `admin-token-weak` interpolates the offending length. */
const findingDetail = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Your admin token is {length} characters — use at least {min} for a brute-force-resistant secret.", {
            length: finding.detail?.["length"],
            min: finding.detail?.["min"],
        }),
        "dev-args-unredacted": t(
            "This worker reports a development environment, so the request log stores raw args and identity. Confirm it isn't a mislabeled production deploy.",
        ),
        "ws-gate-open": t(
            "CIRRUS_WS_BEARER is unset, so the WebSocket upgrade gate is open: live admin subscriptions need no credential. Set it to gate them like the HTTP admin RPCs.",
        ),
    })[finding.kind];

/**
 * The Security Advisor: pulls `getSecurityAudit` for the deployment and lists the
 * findings the server derived from the Worker `env` — weak admin token, an open
 * WebSocket gate, and a dev-mode request log that keeps un-redacted args. These
 * are signals only cirrus can surface: Cloudflare's dashboard is infra-level and
 * can't reason about cirrus's admin/WS gates or its log-redaction policy. The
 * audit is deployment-wide (it reads `env`, identical across shards), so it
 * targets the root shard and needs no shard selector. A snapshot, not a live
 * feed — press Refresh to re-pull.
 */
const SecurityAdvisorPanel = (): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(false);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);

        try {
            const result = (await client.query(GET_SECURITY_AUDIT, {}, callOptions(""))) as SecurityAuditResult;

            // Defensive: an older worker (or a stand-in) may not return a findings
            // array — treat anything but an array as "no findings" rather than throw.
            setFindings(Array.isArray(result.findings) ? result.findings : []);
            setError(null);
        } catch (error_: unknown) {
            setError(errorMessage(error_));
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    return (
        <div className="space-y-4" data-testid="cirrus-security-advisor">
            <div className="flex flex-wrap items-center gap-2">
                <Button data-testid="sec-refresh" disabled={loading} onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                {findings !== null && (
                    <Badge data-testid="sec-count" variant={findings.length > 0 ? "default" : "outline"}>
                        {findings.length}
                    </Badge>
                )}
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="sec-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && findings !== null && findings.length === 0 && (
                <EmptyState
                    description={t("Cirrus checks admin-token strength, the live-subscription gate, and request-log redaction here.")}
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
                    testId="sec-empty"
                    title={t("No security issues detected.")}
                />
            )}

            {error === null && findings !== null && findings.length > 0 && (
                <ul className="space-y-3" data-testid="sec-list">
                    {findings.map((finding) => (
                        <li key={finding.kind}>
                            <Card className="rounded-md">
                                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                                    <CardTitle className="text-sm font-medium">{findingTitle(t, finding)}</CardTitle>
                                    <Badge data-testid={`sec-level-${finding.level}`} variant={LEVEL_VARIANT[finding.level]}>
                                        {finding.level}
                                    </Badge>
                                </CardHeader>
                                <CardContent className="text-sm text-muted-foreground">
                                    <p>{findingDetail(t, finding)}</p>
                                </CardContent>
                            </Card>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default SecurityAdvisorPanel;
