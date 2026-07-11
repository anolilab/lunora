import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId, ProjectId } from "./types";

interface LogsSectionProps {
    organizationId: OrgId;
}

/**
 * Logs tab (GAPS.md B2). Pick a project, then one of its deployments; the
 * tenant runtime lines (tail-worker ingested) render newest-last. The query is
 * live, so the view tails on its own — no polling.
 */
export const LogsSection = ({ organizationId }: LogsSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [scriptName, setScriptName] = useState("");
    const logs = useQuery(api.logs.list, scriptName ? { organizationId, scriptName } : "skip");

    return (
        <div className="stack">
            <section className="card">
                <h3>Runtime logs</h3>
                <label htmlFor="logs-project">
                    Project
                    <select
                        id="logs-project"
                        onChange={(event) => {
                            setProjectId(event.target.value as ProjectId);
                            setScriptName("");
                        }}
                        value={projectId}
                    >
                        <option value="">Select a project…</option>
                        {(projects ?? []).map((project) => (
                            <option key={project._id} value={project._id}>
                                {project.name}
                            </option>
                        ))}
                    </select>
                </label>

                {projectId ? (
                    <label htmlFor="logs-deployment">
                        Deployment
                        <select
                            id="logs-deployment"
                            onChange={(event) => {
                                setScriptName(event.target.value);
                            }}
                            value={scriptName}
                        >
                            <option value="">Select a deployment…</option>
                            {(deployments ?? []).map((deployment) => (
                                <option key={deployment._id} value={deployment.scriptName}>
                                    {deployment.scriptName} ({deployment.status})
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
            </section>

            {scriptName ? (
                <section className="card">
                    <h3>{scriptName}</h3>
                    <pre className="log-view">
                        {(logs ?? []).map((entry) => (
                            <span className={entry.level === "error" ? "log-line error" : "log-line"} key={`${String(entry.createdAt)}-${entry.line}`}>
                                [{new Date(entry.createdAt).toLocaleTimeString()}] {entry.line}
                                {"\n"}
                            </span>
                        ))}
                        {logs?.length === 0 ? "No log lines in the retention window." : null}
                    </pre>
                </section>
            ) : null}
        </div>
    );
};
