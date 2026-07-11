import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface IncidentsSectionProps {
    organizationId: OrgId;
}

/** Human labels for the incident kinds the ingest opens. */
const KIND_LABELS: Record<"crash_loop" | "error_spike" | "oom", string> = {
    crash_loop: "Crash loop",
    error_spike: "Error spike",
    oom: "Out of memory",
};

/**
 * Cloud Observability "Incidents" — higher-level container failures (crash-loop /
 * OOM / error-spike) opened from lifecycle telemetry. Read-only and members-only;
 * gated behind the `logStreams` plan entitlement.
 */
export const IncidentsSection = ({ organizationId }: IncidentsSectionProps): ReactElement => {
    const entitlements = useQuery(api.billing.entitlements, { organizationId });
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const incidents = useQuery(api.incidents.list, gated ? "skip" : { organizationId });

    if (gated) {
        return (
            <section className="card">
                <h3>Incidents</h3>
                <p className="muted">Incident tracking is a Pro feature — upgrade your plan to enable Observability.</p>
            </section>
        );
    }

    return (
        <section className="card">
            <h3>Incidents</h3>
            <AsyncList
                empty="No incidents — container crash-loops and OOMs will appear here."
                render={(rows) => (
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Last seen</th>
                                <th>Incident</th>
                                <th>Kind</th>
                                <th>Container</th>
                                <th>Events</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((incident) => (
                                <tr key={incident._id}>
                                    <td className="muted">{new Date(incident.lastSeen).toLocaleString()}</td>
                                    <td>{incident.title}</td>
                                    <td>{KIND_LABELS[incident.kind]}</td>
                                    <td className="muted">{incident.container ?? "—"}</td>
                                    <td>
                                        <span className="badge">{incident.count}</span>
                                    </td>
                                    <td>{incident.status}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                rows={incidents}
            />
        </section>
    );
};
