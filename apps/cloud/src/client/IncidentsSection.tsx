import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { AsyncList } from "./AsyncList";
import { CrossTabLink } from "./CrossTabLink";

import type { SectionProps } from "./tabs";

/** The structured investigation result the runner produces (mirrors the query view). */
interface InvestigationView {
    by: "deterministic" | "llm";
    confidence: "high" | "low" | "medium";
    evidenceNote: string;
    relatedTraceIds: string[];
    rootCauseHypothesis: string;
    suggestedRemediation: string;
    summary: string;
}

/** Human labels for the incident kinds the ingest opens. */
const KIND_LABELS: Record<"crash_loop" | "error_spike" | "oom", string> = {
    crash_loop: "Crash loop",
    error_spike: "Error spike",
    oom: "Out of memory",
};

/**
 * The rendered investigation panel — summary, root-cause hypothesis, suggested
 * remediation, a confidence + provenance badge, and cross-tab links to the
 * related traces (the shared `CrossTabLink` deep-link, same as Issues/Logs).
 */
const InvestigationPanel = ({ onDismiss, result, title }: { onDismiss: () => void; result: InvestigationView; title: string }): ReactElement => (
    <div className="callout">
        <p>
            <strong>Investigation — {title}</strong> <span className="badge">{result.by === "llm" ? "AI" : "heuristic"}</span>{" "}
            <span className="badge">confidence: {result.confidence}</span>
        </p>
        <p>{result.summary}</p>
        <p>
            <strong>Likely root cause:</strong> {result.rootCauseHypothesis}
        </p>
        <p>
            <strong>Suggested remediation:</strong> {result.suggestedRemediation}
        </p>
        <p className="muted">{result.evidenceNote}</p>
        {result.relatedTraceIds.length > 0 ? (
            <p>
                <strong>Related traces:</strong>{" "}
                {result.relatedTraceIds.map((traceId) => (
                    <CrossTabLink key={traceId} target="traces" traceId={traceId} variant="inline">
                        {traceId.slice(0, 8)}
                    </CrossTabLink>
                ))}
            </p>
        ) : null}
        <button className="link" onClick={onDismiss} type="button">
            Dismiss
        </button>
    </div>
);

/**
 * Cloud Observability "Incidents" — higher-level container failures (crash-loop /
 * OOM / error-spike) opened from lifecycle telemetry. Members-only, gated behind
 * the `logStreams` entitlement. Each incident can be **investigated** on demand
 * (`incidents.investigate` → the pluggable agentic runner): it gathers a
 * read-only evidence bundle (related error spans + correlated logs) and returns a
 * structured result — summary, root-cause hypothesis, suggested remediation,
 * confidence, and related-trace links — which is also persisted on the incident.
 */
export const IncidentsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
    const client = useLunora();
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const incidents = useQuery(api.incidents.list, gated ? "skip" : { organizationId });

    const [investigation, setInvestigation] = useState<{ result: InvestigationView; title: string } | null>(null);
    const [busyId, setBusyId] = useState<Id<"incidents"> | null>(null);
    const [error, setError] = useState<null | string>(null);

    // Only the latest request may write state. Without this, investigating A and
    // then B races: whichever resolves first clears `busyId`, re-enabling the other
    // row's button while its (billed) call is still in flight — and a slow A landing
    // after B would overwrite B's result with a stale one.
    const latestRequest = useRef(0);

    const runInvestigation = (id: Id<"incidents">, title: string): void => {
        const request = latestRequest.current + 1;

        latestRequest.current = request;

        setError(null);
        setBusyId(id);

        // NOTE: `busyId` is cleared in both branches rather than a `finally` — the
        // React Compiler cannot lower a try/finally, so a finalizer clause here
        // silently opts the whole component out of auto-memoization.
        void (async () => {
            try {
                const result = await client.action(api.incidents.investigate, { id, organizationId });

                if (latestRequest.current !== request) {
                    return;
                }

                setInvestigation({ result, title });
                setBusyId(null);
            } catch (error_: unknown) {
                if (latestRequest.current !== request) {
                    return;
                }

                setError(error_ instanceof Error ? error_.message : "investigation failed");
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
            {investigation ? (
                <InvestigationPanel
                    onDismiss={() => {
                        setInvestigation(null);
                    }}

                    result={investigation.result}
                    title={investigation.title}
                />
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
                                <th>Investigation</th>
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
                                                runInvestigation(incident._id, incident.title);
                                            }}
                                            type="button"
                                        >
                                            {busyId === incident._id ? "Investigating…" : incident.investigatedAt ? "Re-investigate" : "Investigate"}
                                        </button>
                                        {incident.investigation ? (
                                            <button
                                                className="link"
                                                onClick={() => {
                                                    setInvestigation({ result: incident.investigation as InvestigationView, title: incident.title });
                                                }}
                                                type="button"
                                            >
                                                View
                                            </button>
                                        ) : null}
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
