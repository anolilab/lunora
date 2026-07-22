import { useLunora } from "@lunora/react";
// Reuse the runtime's health response contract (type-only, so no runtime code is
// pulled into the browser bundle) — the panel must never redefine the wire shape.
import type { HealthBody } from "@lunora/runtime";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { cn } from "../../lib/utils";

// The two public probe routes. Kept as local string constants (rather than
// importing the runtime's `HEALTH_PATH` value) so nothing from `@lunora/runtime`
// is bundled — only the type above, which the compiler erases.
const HEALTH_PATH = "/_lunora/health";
const HEALTH_READY_PATH = "/_lunora/health/ready";

/** Which of the two endpoints a probe targets. */
type ProbeKind = "live" | "ready";

/** The result of one probe fetch — the HTTP status, the parsed body (or `null`), and any transport error. */
interface ProbeSnapshot {
    /** The parsed health body, or `null` when the response wasn't JSON (e.g. an auth-gate rejection). */
    body: HealthBody | null;
    /** A transport/gate error message (network failure, or a non-JSON body), else `undefined`. */
    error?: string;
    /** Whether the HTTP status was 2xx. */
    ok: boolean;
    /** The HTTP status code (`0` when the request never completed). */
    status: number;
}

/** Fetch one probe. Injected in tests; the default (see {@link useDefaultProbe}) hits the live deployment. */
type DeploymentHealthProbe = (kind: ProbeKind) => Promise<ProbeSnapshot>;

interface DeploymentHealthPanelProps {
    /**
     * Injectable probe, used by tests to feed a canned response. When omitted the
     * panel fetches the connected deployment's `/_lunora/health` (and
     * `/health/ready`) directly — this is a plain HTTP route, not an admin RPC, so
     * it doesn't ride the `useAdminQuery` machinery. The admin bearer (when the
     * studio holds one) is attached so an `"admin"`-posture endpoint still answers.
     */
    readonly probe?: DeploymentHealthProbe;
}

/** Join a base origin and an absolute route path without doubling the slash. */
const joinHealthUrl = (base: string, path: string): string => (base.endsWith("/") ? base.slice(0, -1) : base) + path;

/**
 * Build the default probe from the connected client: fetch the health route on
 * the client's origin, attach the admin bearer when the studio holds one (so an
 * `"admin"`-posture endpoint answers), and normalise the response into a
 * {@link ProbeSnapshot}. A non-JSON body (e.g. a bare 403) resolves to
 * `body: null` with an `error`, never a throw.
 */
const useDefaultProbe = (): DeploymentHealthProbe => {
    const client = useLunora();

    return useCallback<DeploymentHealthProbe>(
        async (kind) => {
            const path = kind === "ready" ? HEALTH_READY_PATH : HEALTH_PATH;
            const token = client.getAuthToken();
            const url = joinHealthUrl(client.url, path);

            try {
                const response = await fetch(url, {
                    headers: token === null ? {} : { authorization: `Bearer ${token}` },
                });

                let body: HealthBody | null = null;

                try {
                    body = (await response.json()) as HealthBody;
                } catch {
                    body = null;
                }

                return { body, ok: response.ok, status: response.status };
            } catch (error: unknown) {
                return { body: null, error: error instanceof Error ? error.message : String(error), ok: false, status: 0 };
            }
        },
        [client],
    );
};

/** Overall severity, driving the status dot/ring colours. */
type Level = "crit" | "ok" | "warn";

const LEVEL_DOT: Record<Level, string> = { crit: "bg-destructive", ok: "bg-success", warn: "bg-warning" };
const LEVEL_RING: Record<Level, string> = {
    crit: "bg-destructive/10 text-destructive",
    ok: "bg-success/10 text-success",
    warn: "bg-warning/10 text-warning",
};

/** Map the aggregate body status to a severity level. */
const statusLevel = (status: HealthBody["status"]): Level => {
    if (status === "unhealthy") {
        return "crit";
    }

    return status === "degraded" ? "warn" : "ok";
};

/** One labelled probe tile (Liveness / Readiness) with a status dot and value. */
const ProbeTile = ({ label, level, testId, value }: { label: string; level: Level; testId: string; value: string }): ReactElement => (
    <Card className="gap-0 py-0">
        <div className="flex flex-col gap-2.5 p-4">
            <span className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[level])} />
                {label}
            </span>
            <span className="text-lg font-semibold text-foreground" data-testid={testId}>
                {value}
            </span>
        </div>
    </Card>
);

/**
 * Deployment-health panel: renders the live liveness/readiness verdict and the
 * per-binding/subsystem checks from the deployment's `/_lunora/health` and
 * `/_lunora/health/ready` endpoints (plan 177). This is the operator's at-a-glance
 * "are the bindings up?" view — distinct from the app-level SLO panel (error
 * rate, auth failures, scheduler backlog) that shares the "Health" name.
 *
 * The endpoints are plain HTTP routes (not admin RPCs), so the panel fetches them
 * directly rather than through `useAdminQuery`. The body is deliberately
 * secret-free — only a check name, an up/down status, whether it's critical, and
 * a runtime-authored message (present only in the `"admin"` posture) — so nothing
 * rendered here can leak an env value, connection string, or binding secret.
 */
export const DeploymentHealthPanel = ({ probe }: DeploymentHealthPanelProps): ReactElement => {
    const t = useT();
    const defaultProbe = useDefaultProbe();
    const runProbe = probe ?? defaultProbe;

    const [live, setLive] = useState<ProbeSnapshot | null>(null);
    const [ready, setReady] = useState<ProbeSnapshot | null>(null);
    const [loading, setLoading] = useState(true);

    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);

        const [liveResult, readyResult] = await Promise.all([runProbe("live"), runProbe("ready")]);

        if (!mountedRef.current) {
            return;
        }

        setLive(liveResult);
        setReady(readyResult);
        setLoading(false);
    }, [runProbe]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    if (loading && live === null) {
        return (
            <div className="flex flex-col gap-4" data-testid="deployment-health-loading">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }

    // A completed request that returned no JSON body is treated as unreachable /
    // gated. A 403 specifically means the endpoint is in the `"admin"` posture and
    // the studio is missing (or holds a stale) admin token.
    const body = live?.body ?? null;

    if (body === null) {
        const gated = live?.status === 403;

        return (
            <EmptyState
                description={
                    gated
                        ? t("The health endpoint is in the admin posture. Paste a valid admin token in the connect popover, or set its auth to public.")
                        : t("Couldn't reach the health endpoint: {message}", { message: live?.error ?? t("no response") })
                }
                testId="deployment-health-error"
                title={t("Health endpoint unavailable")}
            />
        );
    }

    const level = statusLevel(body.status);

    let statusLabel: string;

    if (body.status === "unhealthy") {
        statusLabel = t("Unhealthy");
    } else if (body.status === "degraded") {
        statusLabel = t("Degraded");
    } else {
        statusLabel = t("Healthy");
    }

    const readyOk = ready?.ok ?? false;
    const readyLevel: Level = readyOk ? "ok" : "crit";

    const checks = [...body.checks].toSorted((a, b) => a.name.localeCompare(b.name));

    return (
        <div className="flex flex-col gap-6" data-testid="deployment-health">
            <p className="text-sm text-muted-foreground">
                {t(
                    "Live liveness, readiness, and per-binding health from the deployment's /_lunora/health endpoint — wire an uptime monitor or a Cloudflare Health Check at it.",
                )}
            </p>

            {/* Aggregate verdict + app identity. */}
            <Card className="gap-0 py-0">
                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                    <div className="flex items-center gap-3">
                        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", LEVEL_RING[level])}>
                            <span className={cn("size-3 rounded-full", LEVEL_DOT[level])} />
                        </span>
                        <div className="grid leading-tight">
                            <span className="text-sm font-semibold text-foreground" data-testid="dh-status">
                                {statusLabel}
                            </span>
                            <span className="font-mono text-[13px] text-muted-foreground" data-testid="dh-app">
                                {body.appName} · {body.appVersion}
                            </span>
                        </div>
                    </div>
                    <div className="text-end">
                        <div className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Checked")}</div>
                        <time className="text-[13px] text-muted-foreground" data-testid="dh-timestamp">
                            {new Date(body.timestamp).toLocaleString()}
                        </time>
                    </div>
                </div>
            </Card>

            {/* Liveness + readiness tiles. */}
            <div className="grid gap-3 sm:grid-cols-2" data-testid="dh-probes">
                <ProbeTile label={t("Liveness")} level={level} testId="dh-liveness" value={statusLabel} />
                <ProbeTile label={t("Readiness")} level={readyLevel} testId="dh-readiness" value={readyOk ? t("Ready") : t("Not ready")} />
            </div>

            {/* Per-check table. */}
            <Card className="gap-0 py-0" data-testid="dh-checks">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Subsystem checks")}</span>
                </header>
                {checks.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="dh-checks-empty">
                        {t("No checks reported.")}
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {checks.map((check) => (
                            <li
                                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs"
                                data-testid={`dh-check-${check.name}`}
                                key={check.name}
                            >
                                <span className="flex items-center gap-2">
                                    <span
                                        aria-hidden="true"
                                        className={cn("size-1.5 shrink-0 rounded-full", check.status === "up" ? "bg-success" : "bg-destructive")}
                                    />
                                    <span className="font-mono text-foreground">{check.name}</span>
                                    {check.critical && <Badge variant="outline">{t("Critical")}</Badge>}
                                </span>
                                <span className="flex shrink-0 items-center gap-2">
                                    {check.message !== undefined && <span className="text-muted-foreground">{check.message}</span>}
                                    <Badge data-testid={`dh-check-status-${check.name}`} variant={check.status === "up" ? "secondary" : "destructive"}>
                                        {check.status === "up" ? t("Up") : t("Down")}
                                    </Badge>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
};

export type { DeploymentHealthPanelProps, DeploymentHealthProbe, ProbeSnapshot };
