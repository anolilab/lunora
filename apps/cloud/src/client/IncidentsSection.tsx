import { useLunora, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
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
 * OOM / error-spike) opened from lifecycle telemetry. Members-only, gated behind
 * the `logStreams` entitlement. Each incident can be AI-triaged on demand
 * (`incidents.triage` → Workers AI): a root-cause summary + next step.
 */
export const IncidentsSection = ({ organizationId }: IncidentsSectionProps): ReactElement => {
    const client = useLunora();
    const entitlements = useQuery(api.billing.entitlements, { organizationId });
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const incidents = useQuery(api.incidents.list, gated ? "skip" : { organizationId });

    const [triage, setTriage] = useState<{ summary: string; title: string } | null>(null);
    const [busyId, setBusyId] = useState<Id<"incidents"> | null>(null);
    const [error, setError] = useState<null | string>(null);

    // Only the latest triage request may write state. Without this, triaging A and
    // then B races: whichever resolves first clears `busyId`, re-enabling the other
    // row's button while its (billed) call is still in flight — and a slow A landing
    // after B would overwrite B's summary with a stale one.
    const latestRequest = useRef(0);

    const runTriage = (id: Id<"incidents">, title: string): void => {
        const request = latestRequest.current + 1;

        latestRequest.current = request;

        setError(null);
        setBusyId(id);

        // NOTE: `busyId` is cleared in both branches rather than a `finally` — the
        // React Compiler cannot lower a try/finally, so a finalizer clause here
        // silently opts the whole component out of auto-memoization.
        void (async () => {
            try {
                const { summary } = await client.action(api.incidents.triage, { id, organizationId });

                if (latestRequest.current !== request) {
                    return;
                }

                setTriage({ summary, title });
                setBusyId(null);
            } catch (error_: unknown) {
                if (latestRequest.current !== request) {
                    return;
                }

                setError(error_ instanceof Error ? error_.message : "triage failed");
                setBusyId(null);
            }
        })();
    };

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
            {error ? (
                <p className="error" role="alert">
                    {error}
                </p>
            ) : null}
            {triage ? (
                <div className="callout">
                    <p>
                        <strong>AI triage — {triage.title}</strong>
                    </p>
                    <p>{triage.summary}</p>
                    <button
                        className="link"
                        onClick={() => {
                            setTriage(null);
                        }}
                        type="button"
                    >
                        Dismiss
                    </button>
                </div>
            ) : null}
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
                                <th>Triage</th>
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
                                    <td>
                                        <button
                                            className="link"
                                            disabled={busyId === incident._id}
                                            onClick={() => {
                                                runTriage(incident._id, incident.title);
                                            }}
                                            type="button"
                                        >
                                            {busyId === incident._id ? "Triaging…" : "Triage"}
                                        </button>
                                    </td>
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
