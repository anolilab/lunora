import type { Preloaded, ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { AsyncList } from "./AsyncList";
import type { OrgId, ProjectId } from "./types";

interface BuildsSectionProps {
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<ReturnOf<typeof api.projects.listByOrg>>;
}

type BuildId = Id<"builds">;

/**
 * Builds tab (GAPS.md A3). Pick a project → its builds (live, newest first;
 * push-to-deploy creates them) → expand one to tail its streamed output. The
 * log query is live, so lines appear as the runner writes them.
 */
export const BuildsSection = ({ organizationId, preloaded }: BuildsSectionProps): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const builds = useQuery(api.builds.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [openBuildId, setOpenBuildId] = useState<BuildId | "">("");
    const logs = useQuery(api.builds.logs, openBuildId ? { buildId: openBuildId, organizationId } : "skip");

    return (
        <div className="stack">
            <section className="card">
                <h3>Builds</h3>
                <label htmlFor="build-project">
                    Project
                    <select
                        id="build-project"
                        onChange={(event) => {
                            setProjectId(event.target.value as ProjectId);
                            setOpenBuildId("");
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
                    <AsyncList
                        empty="No builds yet — push to the connected repository to trigger one."
                        render={(rows) => (
                            <ul className="list">
                                {rows.map((build) => (
                                    <li className="row" key={build._id}>
                                        <span className="row-title">{build.commitSha.slice(0, 10)}</span>
                                        <span className="muted">{build.branch}</span>
                                        <span className="badge">{build.status}</span>
                                        <span className="muted">{new Date(build.createdAt).toLocaleString()}</span>
                                        <button
                                            className="link"
                                            onClick={() => {
                                                setOpenBuildId(openBuildId === build._id ? "" : build._id);
                                            }}
                                            type="button"
                                        >
                                            {openBuildId === build._id ? "Hide logs" : "Logs"}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        rows={builds}
                    />
                ) : null}
            </section>

            {openBuildId ? (
                <section className="card">
                    <h3>Build output</h3>
                    <pre className="log-view">
                        {(logs ?? []).map((entry) => (
                            <span className={entry.level === "error" ? "log-line error" : "log-line"} key={`${String(entry.createdAt)}-${entry.line}`}>
                                {entry.line}
                                {"\n"}
                            </span>
                        ))}
                        {logs?.length === 0 ? "No output yet…" : null}
                    </pre>
                </section>
            ) : null}
        </div>
    );
};
