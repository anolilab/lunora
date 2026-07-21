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

/** One log line, as the waterfall reads it (a subset of the `logs.list` row). */
interface TraceLine {
    createdAt: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: string;
    message: string;
    spanId?: string;
}

/** One positioned waterfall row: a log line placed on the trace's timeline. */
interface WaterfallRow extends TraceLine {
    /** Right edge of the bar, as a percent of the trace span. */
    endPct: number;
    /** Offset from the trace start, in ms. */
    offsetMs: number;
    /** Left edge of the bar, as a percent of the trace span. */
    startPct: number;
}

/**
 * Lay each log line out on the trace's timeline: its bar starts at its offset and
 * runs to the next line's offset (the time that elapsed before the next log) — so
 * the lines cascade like a span waterfall. The last line (and a zero-span trace)
 * gets a small fixed tail so it stays visible. Lines are sorted oldest-first.
 */
const buildWaterfall = (lines: ReadonlyArray<TraceLine>, startMs: number, spanMs: number): WaterfallRow[] => {
    const sorted = [...lines].toSorted((a, b) => a.createdAt - b.createdAt);
    const pct = (ms: number): number => (spanMs > 0 ? Math.min((Math.max(ms, 0) / spanMs) * 100, 100) : 0);

    return sorted.map((line, index) => {
        const offsetMs = Math.max(line.createdAt - startMs, 0);
        const startPct = pct(offsetMs);
        const next = sorted[index + 1];
        const rawEnd = next === undefined ? startPct + 4 : pct(next.createdAt - startMs);

        return { ...line, endPct: Math.min(Math.max(rawEnd, startPct + 1.2), 100), offsetMs, startPct };
    });
};

/**
 * Traces tab (GAPS.md B2 follow-up — log↔trace correlation). Pick a project, then
 * a deployment; the recent dispatch traces render newest-active first, each a fold
 * of the tenant log lines sharing a `traceId` — root function, a duration bar
 * (relative to the longest trace on screen), line count, and peak severity (a red
 * row saw an `error`/`fatal`). Select a trace to drill into its **waterfall**:
 * each line is a bar placed on the trace's timeline, so the dispatch cascades top
 * to bottom — reusing the same `logs.list` read the Logs tab uses (filtered to the
 * one `traceId`). Both queries are live.
 *
 * The cloud stores no OpenTelemetry span durations (the OTLP path keeps only error
 * spans → Issues), so a bar runs from a line's offset to the *next* line's — the
 * gap until the next log, not a true span duration. A real span waterfall would
 * need a span store (noted in GAPS.md).
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
    const traceEnd = selected?.endedAt ?? (lines && lines.length > 0 ? Math.max(...lines.map((line) => line.createdAt)) : traceStart);
    const spanMs = Math.max(traceEnd - traceStart, 0);
    const waterfall = buildWaterfall(lines ?? [], traceStart, spanMs);

    // The longest trace on screen, so each list row's duration bar reads relative to it.
    const maxSpan = Math.max(1, ...(traces ?? []).map((trace) => trace.endedAt - trace.startedAt));

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
                                    <td>
                                        <div className="trace-dur">
                                            <div className="trace-dur-track">
                                                <div
                                                    className={`trace-dur-fill trace-fill-${trace.maxLevel}`}
                                                    style={{ width: `${String(Math.max(((trace.endedAt - trace.startedAt) / maxSpan) * 100, 3))}%` }}
                                                />
                                            </div>
                                            <span className="muted trace-dur-label">{formatSpan(trace.startedAt, trace.endedAt)}</span>
                                        </div>
                                    </td>
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
                <section className="card trace-detail">
                    <header className="trace-detail-head">
                        <div>
                            <span className="trace-detail-id">{traceId.slice(0, 16)}</span>
                            {selected ? (
                                <span className="trace-detail-meta">
                                    {selected.lineCount} spans · {formatSpan(selected.startedAt, selected.endedAt)}
                                    {selected.hasError ? <span className="trace-detail-err"> · errored</span> : null}
                                </span>
                            ) : null}
                        </div>
                        <button className="trace-close" onClick={() => setTraceId("")} type="button">
                            Close
                        </button>
                    </header>

                    {lines === undefined ? <p className="muted">Loading…</p> : null}
                    {lines?.length === 0 ? <p className="muted">No lines for this trace in the retention window.</p> : null}

                    <div className="trace-waterfall">
                        {waterfall.map((row, index) => (
                            <div
                                className={`trace-wrow${row.level === "error" || row.level === "fatal" ? " trace-wrow-err" : ""}`}
                                key={`${String(row.createdAt)}-${String(index)}`}
                            >
                                <span className="trace-off">+{String(row.offsetMs)}ms</span>
                                <div className="trace-track" title={`+${String(row.offsetMs)}ms`}>
                                    <div
                                        className={`trace-bar trace-fill-${row.level}`}
                                        style={{ left: `${String(row.startPct)}%`, width: `${String(Math.max(row.endPct - row.startPct, 0.8))}%` }}
                                    />
                                </div>
                                <div className="trace-wmeta">
                                    <span className={`log-badge log-badge-${row.level}`}>{row.level}</span>{" "}
                                    {row.spanId ? <span className="trace-span-id">{row.spanId.slice(0, 8)}</span> : null}{" "}
                                    {row.functionPath ? <span className="log-fn">{row.functionPath}</span> : null}{" "}
                                    <span className="trace-msg">{row.message}</span>
                                    {row.fields ? <span className="log-fields"> {renderFields(row.fields)}</span> : null}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}
        </div>
    );
};
