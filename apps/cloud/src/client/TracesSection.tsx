import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId, ProjectId } from "./types";

interface TracesSectionProps {
    organizationId: OrgId;
}

/** Render a structured fields bag as compact, space-joined `key=value` pairs. */
const renderFields = (fields: Record<string, unknown>): string =>
    Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ");

/** Duration between the trace's first and last line, as a compact `12ms` / `1.4s`. */
const formatSpan = (startedAt: number, endedAt: number): string => {
    const ms = Math.max(endedAt - startedAt, 0);

    return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};

/**
 * Traces tab (GAPS.md B2 follow-up — log↔trace correlation). Pick a project, then
 * a deployment; the recent dispatch traces render newest-active first, each one a
 * fold of the tenant log lines sharing a `traceId` — its root function, span of
 * time, line count, and peak severity (a red row saw an `error`/`fatal`). Select
 * a trace to drill into its timeline: every line it emitted, in order, with the
 * offset from the trace start — reusing the same `logs.list` read the Logs tab
 * uses (filtered to the one `traceId`). Both queries are live.
 *
 * The cloud stores no OpenTelemetry spans (durations), so this is a
 * log-reconstructed trace timeline, not a span waterfall — a true span view would
 * need a separate span store (noted in GAPS.md).
 */
export const TracesSection = ({ organizationId }: TracesSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [scriptName, setScriptName] = useState("");
    const [traceId, setTraceId] = useState("");

    const traces = useQuery(api.logs.listTraces, scriptName ? { organizationId, scriptName } : "skip");
    const lines = useQuery(api.logs.list, scriptName && traceId ? { organizationId, scriptName, traceId } : "skip");

    // The selected trace's own summary (for the drill-in header) + its start ts,
    // so each line can show its offset from the trace start.
    const selected = (traces ?? []).find((trace) => trace.traceId === traceId);
    // Lines come back newest-first; the trace starts at the oldest.
    const traceStart = selected?.startedAt ?? (lines && lines.length > 0 ? Math.min(...lines.map((line) => line.createdAt)) : 0);

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
                            setScriptName("");
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
                                setScriptName(event.target.value);
                                setTraceId("");
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
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Trace</th>
                                <th>Root function</th>
                                <th>Lines</th>
                                <th>Span</th>
                                <th>Level</th>
                                <th>Started</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(traces ?? []).map((trace) => (
                                <tr
                                    aria-selected={trace.traceId === traceId}
                                    className={`trace-clickable${trace.hasError ? " trace-error" : ""}${trace.traceId === traceId ? " active" : ""}`}
                                    key={trace.traceId}
                                    onClick={() => setTraceId(trace.traceId === traceId ? "" : trace.traceId)}
                                >
                                    <td className="trace-id">{trace.traceId.slice(0, 12)}</td>
                                    <td className="log-fn">{trace.functionPath ?? "—"}</td>
                                    <td>{trace.lineCount}</td>
                                    <td className="muted">{formatSpan(trace.startedAt, trace.endedAt)}</td>
                                    <td>
                                        <span className={`log-badge log-badge-${trace.maxLevel}`}>{trace.maxLevel}</span>
                                    </td>
                                    <td className="muted">{new Date(trace.startedAt).toLocaleTimeString()}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {traces?.length === 0 ? (
                        <p className="muted">No traces in the retention window. Traces appear as your app handles dispatched requests.</p>
                    ) : null}
                </section>
            ) : null}

            {traceId ? (
                <section className="card">
                    <h4>
                        Trace {traceId.slice(0, 12)}
                        {selected ? ` · ${String(selected.lineCount)} lines · ${formatSpan(selected.startedAt, selected.endedAt)}` : ""}
                    </h4>
                    <pre className="log-view">
                        {[...(lines ?? [])]
                            .toSorted((a, b) => a.createdAt - b.createdAt)
                            .map((entry, index) => (
                                <span className={`log-line log-line-${entry.level}`} key={`${String(entry.createdAt)}-${String(index)}`}>
                                    <span className="log-time">+{String(Math.max(entry.createdAt - traceStart, 0))}ms</span>{" "}
                                    <span className={`log-badge log-badge-${entry.level}`}>{entry.level}</span>{" "}
                                    {entry.spanId ? <span className="trace-span-id">{entry.spanId.slice(0, 8)}</span> : null}{" "}
                                    {entry.functionPath ? <span className="log-fn">{entry.functionPath}</span> : null} {entry.message}
                                    {entry.fields ? <span className="log-fields"> {renderFields(entry.fields as Record<string, unknown>)}</span> : null}
                                    {"\n"}
                                </span>
                            ))}
                        {lines?.length === 0 ? "No lines for this trace in the retention window." : null}
                    </pre>
                </section>
            ) : null}
        </div>
    );
};
