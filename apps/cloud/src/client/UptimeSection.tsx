import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface UptimeSectionProps {
    organizationId: OrgId;
}

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
 */
export const UptimeSection = ({ organizationId }: UptimeSectionProps): ReactElement => {
    const entitlements = useQuery(api.billing.entitlements, { organizationId });
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const rows = useQuery(api.uptime.summary, gated ? "skip" : { organizationId });

    if (gated) {
        return (
            <section className="card">
                <h3>Uptime</h3>
                <p className="muted">Uptime monitoring is a Pro feature — upgrade your plan to enable Observability.</p>
            </section>
        );
    }

    return (
        <section className="card">
            <h3>Uptime</h3>
            <p className="muted">
                Each live deployment is probed from outside Cloudflare every minute. Add an uptime alert on the Alerts tab to get paged on an outage.
            </p>
            <AsyncList
                empty="No probes yet — live deployments are checked automatically once a minute."
                render={(summaries) => (
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Deployment</th>
                                <th>Status</th>
                                <th>Uptime (1h)</th>
                                <th>Latency</th>
                                <th>Failing</th>
                                <th>Last checked</th>
                            </tr>
                        </thead>
                        <tbody>
                            {summaries.map((row) => (
                                <tr key={row.deploymentId}>
                                    <td className="muted">{row.deploymentId}</td>
                                    <td>
                                        <span className={row.ok ? "badge" : "badge error"}>{row.ok ? "Up" : "Down"}</span>
                                    </td>
                                    <td>{row.sampleCount === 0 ? "—" : formatUptime(row.upFraction)}</td>
                                    <td className="muted">{formatLatency(row.avgLatencyMs)}</td>
                                    <td>{row.consecutiveFailures > 0 ? <span className="badge error">{row.consecutiveFailures}</span> : "—"}</td>
                                    <td className="muted">{new Date(row.lastCheckedAt).toLocaleString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                rows={rows}
            />
        </section>
    );
};
