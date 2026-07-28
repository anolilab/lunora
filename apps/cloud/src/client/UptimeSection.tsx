import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { COLUMN_LABEL, StatusBadge, Upsell } from "./section-ui";
import type { SectionProps } from "./tabs";

/** Format a `[0,1]` uptime fraction as a percentage, to two decimals. */
const formatUptime = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

/** Format a mean latency in ms, or a dash when no successful probe has landed. */
const formatLatency = (ms: number | undefined): string => (ms === undefined ? "—" : `${Math.round(ms)}ms`);

/**
 * Cloud Observability "Uptime" — synthetic availability. The control plane probes
 * each live deployment's URL from the outside every minute (`src/uptime/sweep.ts`)
 * and records the result; this grid shows each deployment's current status, its
 * rolling uptime over the last hour, and mean probe latency. Members-only, gated
 * behind the `logStreams` entitlement like Issues/Incidents. Configure an alert
 * that pages you on an outage from the Alerts tab (target "uptime").
 *
 * Hierarchy: availability is the point, so the uptime percentage is the one value
 * rendered at size, in mono — data as the visual. Status and failure count are the
 * only tinted things on a row, and they tint the VALUE, never the row; latency,
 * deployment id and timestamp stay tertiary.
 */
export const UptimeSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const rows = useQuery(api.uptime.summary, gated ? "skip" : { organizationId });

    if (gated) {
        return <Upsell title="Uptime">Uptime monitoring is a Pro feature — upgrade your plan to enable Observability.</Upsell>;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Uptime</CardTitle>
                <CardDescription>
                    Each live deployment is probed from outside Cloudflare every minute. Add an uptime alert on the Alerts tab to get paged on an outage.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <AsyncList
                    empty="No probes yet — live deployments are checked automatically once a minute."
                    render={(summaries) => (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className={COLUMN_LABEL}>Deployment</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Uptime (1h)</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Latency</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Failing</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Last checked</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {summaries.map((row) => (
                                    <TableRow key={row.deploymentId}>
                                        <TableCell className="text-muted-foreground font-mono text-xs">{row.deploymentId}</TableCell>
                                        <TableCell>
                                            <StatusBadge tone={row.ok ? "success" : "danger"}>{row.ok ? "Up" : "Down"}</StatusBadge>
                                        </TableCell>
                                        {/* The one value shown at size: availability is what this screen exists to answer. */}
                                        <TableCell className="font-mono text-base tabular-nums">
                                            {row.sampleCount === 0 ? "—" : formatUptime(row.upFraction)}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">{formatLatency(row.avgLatencyMs)}</TableCell>
                                        <TableCell>
                                            {row.consecutiveFailures > 0 ? <StatusBadge tone="danger">{row.consecutiveFailures}</StatusBadge> : "—"}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                                            {new Date(row.lastCheckedAt).toLocaleString()}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    rows={rows}
                />
            </CardContent>
        </Card>
    );
};
