import type { Preloaded, ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { CrossTabLink } from "./CrossTabLink";
import type { OrgId } from "./types";

interface IssuesSectionProps {
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<ReturnOf<typeof api.billing.entitlements>>;
}

/**
 * Cloud Observability "Issues" — grouped application errors across the org's
 * deployments (the hosted counterpart of the local Studio's Issues). Read-only
 * and members-only; gated behind the `logStreams` plan entitlement.
 */
export const IssuesSection = ({ organizationId, preloaded }: IssuesSectionProps): ReactElement => {
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const issues = useQuery(api.issues.list, gated ? "skip" : { organizationId });

    if (gated) {
        return (
            <section className="card">
                <h3>Issues</h3>
                <p className="muted">Grouped error tracking is a Pro feature — upgrade your plan to enable Observability.</p>
            </section>
        );
    }

    return (
        <section className="card">
            <h3>Issues</h3>
            <AsyncList
                empty="No issues yet — errors from your deployments will group here."
                render={(rows) => (
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Last seen</th>
                                <th>Issue</th>
                                <th>Culprit</th>
                                <th>Events</th>
                                <th>Status</th>
                                <th>Trace</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((issue) => (
                                <tr key={issue._id}>
                                    <td className="muted">{new Date(issue.lastSeen).toLocaleString()}</td>
                                    <td>{issue.title}</td>
                                    <td className="muted">{issue.culprit}</td>
                                    <td>
                                        <span className="badge">{issue.count}</span>
                                    </td>
                                    <td>{issue.status}</td>
                                    <td>
                                        {issue.sampleTraceId ? (
                                            <CrossTabLink target="traces" traceId={issue.sampleTraceId}>
                                                View trace
                                            </CrossTabLink>
                                        ) : (
                                            <span className="muted">—</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                rows={issues}
            />
        </section>
    );
};
