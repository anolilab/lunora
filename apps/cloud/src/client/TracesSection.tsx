import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { buildTraceTree } from "../telemetry/trace-tree";
import { api } from "../../lunora/_generated/api.js";
import type { DeploymentId, OrgId, ProjectId } from "./types";

interface TracesSectionProps {
    organizationId: OrgId;
}

/** Duration as a compact `12ms` / `1.4s`. */
const formatMs = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Traces tab — real-duration, nested trace waterfalls over the span store
 * (`observations`), the Langfuse-teardown follow-on. Pick a project, then a
 * deployment; recent dispatch traces render newest-active first (via
 * `traces.list`), each with its real latency bar, span count, and error count.
 * Select one to drill into its **waterfall** (`traces.get` → `buildTraceTree`):
 * every span placed on the trace timeline by its real start + duration and
 * indented by its depth under `parentSpanId` — a true span waterfall, not a
 * log-gap timeline. Both queries are live.
 */
export const TracesSection = ({ organizationId }: TracesSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [deploymentId, setDeploymentId] = useState<DeploymentId | "">("");
    const [traceId, setTraceId] = useState("");

    const traces = useQuery(api.traces.list, deploymentId ? { deploymentId, organizationId } : "skip");
    const spans = useQuery(api.traces.get, traceId ? { organizationId, traceId } : "skip");

    const selected = (traces ?? []).find((trace) => trace.traceId === traceId);
    const waterfall = buildTraceTree(spans ?? []);

    // The longest trace on screen, so each list row's latency bar reads relative to it.
    const maxDuration = Math.max(1, ...(traces ?? []).map((trace) => trace.durationMs));

    return (
        <div className="stack">
            <section className="card">
                <h3>Traces</h3>
                <label htmlFor="traces-project">
                    Project
                    <select
                        id="traces-project"
                        onChange={(event) => {
                            setProjectId(event.target.value as ProjectId);
                            setDeploymentId("");
                            setTraceId("");
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
                    <label htmlFor="traces-deployment">
                        Deployment
                        <select
                            id="traces-deployment"
                            onChange={(event) => {
                                setDeploymentId(event.target.value as DeploymentId);
                                setTraceId("");
                            }}
                            value={deploymentId}
                        >
                            <option value="">Select a deployment…</option>
                            {(deployments ?? []).map((deployment) => (
                                <option key={deployment._id} value={deployment._id}>
                                    {deployment.scriptName} ({deployment.status})
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
            </section>

            {deploymentId ? (
                <section className="card">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Trace</th>
                                <th>Root operation</th>
                                <th>Spans</th>
                                <th>Latency</th>
                                <th>Status</th>
                                <th>Started</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(traces ?? []).map((trace) => (
                                <tr
                                    aria-selected={trace.traceId === traceId}
                                    className={`trace-clickable${trace.errorCount > 0 ? " trace-error" : ""}${trace.traceId === traceId ? " active" : ""}`}
                                    key={trace.traceId}
                                    onClick={() => setTraceId(trace.traceId === traceId ? "" : trace.traceId)}
                                >
                                    <td className="trace-id">{trace.traceId.slice(0, 12)}</td>
                                    <td className="log-fn">{trace.rootFunctionPath ?? trace.rootName}</td>
                                    <td>{trace.spanCount}</td>
                                    <td>
                                        <div className="trace-dur">
                                            <div className="trace-dur-track">
                                                <div
                                                    className={`trace-dur-fill trace-fill-${trace.errorCount > 0 ? "error" : "info"}`}
                                                    style={{ width: `${String(Math.max((trace.durationMs / maxDuration) * 100, 3))}%` }}
                                                />
                                            </div>
                                            <span className="muted trace-dur-label">{formatMs(trace.durationMs)}</span>
                                        </div>
                                    </td>
                                    <td>
                                        {trace.errorCount > 0 ? (
                                            <span className="log-badge log-badge-error">{trace.errorCount} error</span>
                                        ) : (
                                            <span className="log-badge log-badge-info">ok</span>
                                        )}
                                    </td>
                                    <td className="muted">{new Date(trace.startedAt).toLocaleTimeString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {traces?.length === 0 ? (
                        <p className="muted">
                            No traces yet. Spans arrive as your app handles dispatched requests (or you point an OTel exporter at /v1/traces).
                        </p>
                    ) : null}
                </section>
            ) : null}

            {traceId ? (
                <section className="card">
                    <header className="trace-detail-head">
                        <div>
                            <span className="trace-detail-id">{traceId.slice(0, 16)}</span>
                            {selected ? (
                                <span className="trace-detail-meta">
                                    {selected.spanCount} spans · {formatMs(selected.durationMs)}
                                    {selected.errorCount > 0 ? <span className="trace-detail-err"> · {selected.errorCount} error</span> : null}
                                </span>
                            ) : null}
                        </div>
                        <button className="trace-close" onClick={() => setTraceId("")} type="button">
                            Close
                        </button>
                    </header>

                    {spans === undefined ? <p className="muted">Loading…</p> : null}
                    {spans?.length === 0 ? <p className="muted">No spans for this trace in the retention window.</p> : null}

                    <div className="trace-waterfall">
                        {waterfall.map((row) => (
                            <div className={`trace-wrow${row.level === "error" ? " trace-wrow-err" : ""}`} key={row.spanId}>
                                <span className="trace-off">+{String(row.offsetMs)}ms</span>
                                <div className="trace-track" title={`${formatMs(row.durationMs)} at +${String(row.offsetMs)}ms`}>
                                    <div
                                        className={`trace-bar trace-fill-${row.level}`}
                                        style={{ left: `${String(row.startPct)}%`, width: `${String(Math.max(row.durationPct, 0.8))}%` }}
                                    />
                                </div>
                                <div className="trace-wmeta" style={{ paddingLeft: `${String(row.depth * 16)}px` }}>
                                    {row.kind === "generation" ? <span className="trace-gen-badge">gen</span> : null}
                                    {row.functionPath ? <span className="log-fn">{row.functionPath}</span> : <span className="trace-msg">{row.name}</span>}
                                    <span className="muted"> {formatMs(row.durationMs)}</span>
                                    {row.kind === "generation" ? (
                                        <span className="trace-gen-meta">
                                            {row.model ?? "generation"}
                                            {row.promptTokens !== undefined || row.completionTokens !== undefined
                                                ? ` · ${String(row.promptTokens ?? 0)}→${String(row.completionTokens ?? 0)} tok`
                                                : ""}
                                        </span>
                                    ) : null}
                                    {row.statusMessage ? <span className="log-fields"> {row.statusMessage}</span> : null}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}
        </div>
    );
};
