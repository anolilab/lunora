import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId, ProjectId } from "./types";

interface DeploymentsSectionProps {
    onBack: () => void;
    organizationId: OrgId;
    projectId: ProjectId; // secret-scanner:allow -- domain field name
    projectName: string;
}

const formatTime = (ms: number): string => new Date(ms).toLocaleString();

/**
 * A project's deployments (live). Deploys themselves are created out-of-band —
 * by the CLI (`lunora deploy`) or the GitHub webhook — so this view is
 * read-only: it surfaces each deployment's kind, status, live URL, and the
 * branch/commit it came from.
 */
export const DeploymentsSection = ({ onBack, organizationId, projectId, projectName }: DeploymentsSectionProps): ReactElement => {
    const deployments = useQuery(api.deployments.listByProject, { organizationId, projectId });
    const rollback = useMutation(api.deployments.rollback);

    return (
        <div className="stack">
            <div className="breadcrumb">
                <button className="link" onClick={onBack} type="button">
                    ← Projects
                </button>
                <h3>{projectName}</h3>
            </div>

            <section className="card">
                <h3>Deployments</h3>
                <p className="muted">Deployments are created by the CLI (`lunora deploy`) or the GitHub integration.</p>
                <AsyncList
                    empty="No deployments yet."
                    render={(rows) => (
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Kind</th>
                                    <th>Status</th>
                                    <th>URL</th>
                                    <th>Branch</th>
                                    <th>Created</th>
                                    <th aria-label="Actions" />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((deployment) => (
                                    <tr key={deployment._id}>
                                        <td>
                                            <span className="badge">{deployment.kind}</span>
                                        </td>
                                        <td>
                                            <span className={`status status-${deployment.status}`}>{deployment.status}</span>
                                        </td>
                                        <td>
                                            {deployment.url ? (
                                                <a href={deployment.url} rel="noreferrer" target="_blank">
                                                    {deployment.url}
                                                </a>
                                            ) : (
                                                <span className="muted">—</span>
                                            )}
                                        </td>
                                        <td>{deployment.branch ?? <span className="muted">—</span>}</td>
                                        <td className="muted">{formatTime(deployment.createdAt)}</td>
                                        <td>
                                            {deployment.status === "superseded" ? (
                                                <button
                                                    className="link"
                                                    onClick={() => {
                                                        void rollback.mutate({ id: deployment._id, organizationId });
                                                    }}
                                                    type="button"
                                                >
                                                    Roll back
                                                </button>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    rows={deployments}
                />
            </section>
        </div>
    );
};
