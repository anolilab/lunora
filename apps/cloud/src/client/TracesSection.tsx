import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { buildTraceTree } from "../telemetry/trace-tree";
import { CrossTabLink } from "./CrossTabLink";
import { formatMs } from "./format";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import { SpanDetail, TraceWaterfall } from "./TraceDetail";
import type { DeploymentId, ProjectId } from "./types";
import type { SectionProps } from "./tabs";

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
export const TracesSection = ({ focusTraceId, organizationId, preloaded }: SectionProps<ReturnOf<typeof api.projects.listByOrg>>): ReactElement => {
    const client = useLunora();
    const { from, to } = useTimeRange();
    const projects = usePreloadedQuery(preloaded);
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [deploymentId, setDeploymentId] = useState<DeploymentId | "">("");
    // Deep-link in: open the focused trace's waterfall directly (`traces.get` needs
    // only org + traceId, so no project/deployment pick is required) as a one-shot
    // state seed, so the user can then browse to other traces.
    //
    // Depends on the route's `key={traceId}` to remount when `?traceId=` changes —
    // the router does not remount on a search-param change by itself. Note the
    // converse limitation: selecting a different trace *in the table* updates this
    // local state without rewriting the URL, so an in-page selection is not
    // shareable. Incoming links are; making outgoing selections shareable means
    // driving this through `navigate({ search })`.
    const [traceId, setTraceId] = useState(focusTraceId ?? "");
    const [errorOnly, setErrorOnly] = useState(false);
    const [selectedSpanId, setSelectedSpanId] = useState("");
    // Archive fallback: the spans `traces.getArchived` returned, tagged with the
    // trace they were fetched for. Keying by `traceId` means a stale fetch for a
    // previous trace is simply ignored downstream — no reset effect (which would
    // chain an extra render on every trace switch).
    const [archived, setArchived] = useState<{ spans: NonNullable<typeof spans>; traceId: string } | undefined>(undefined);

    const traces = useQuery(api.traces.list, deploymentId ? { deploymentId, errorOnly, from, organizationId, to } : "skip");
    const spans = useQuery(api.traces.get, traceId ? { organizationId, traceId } : "skip");

    // D1 has no spans for this trace (loaded, empty) → try the columnar archive
    // (an action — the R2-SQL read is a `fetch`). Fails open to `[]`, so the
    // waterfall just stays empty when the archive isn't configured.
    const d1Empty = traceId !== "" && spans?.length === 0;

    useEffect(() => {
        if (!d1Empty) {
            return;
        }

        let cancelled = false;

        client
            .action(api.traces.getArchived, { organizationId, traceId })
            .then((result) => {
                if (!cancelled) {
                    setArchived({ spans: result, traceId });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setArchived({ spans: [], traceId });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, d1Empty, organizationId, traceId]);

    // Seamless "load older": traces past D1's hot window folded straight from the
    // columnar archive (`traces.listArchived`, an action). Keyed by the current
    // browse context so a stale result for a previous deployment/range is ignored
    // downstream (mirrors the per-trace archive keying above — no reset effect).
    const [olderArchive, setOlderArchive] = useState<{ key: string; traces: NonNullable<typeof traces> } | undefined>(undefined);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const archiveKey = `${deploymentId}:${String(from)}:${String(to)}`;
    const olderTraces = olderArchive?.key === archiveKey ? olderArchive.traces : undefined;

    const loadOlderFromArchive = (): void => {
        setLoadingOlder(true);
        client
            .action(api.traces.listArchived, { from, organizationId, to })
            .then((rows) => {
                setOlderArchive({ key: archiveKey, traces: rows });
            })
            .catch(() => {
                setOlderArchive({ key: archiveKey, traces: [] });
            })
            .finally(() => {
                setLoadingOlder(false);
            });
    };

    // Only honor the archive fetch that belongs to the trace currently open (a
    // stale fetch for a previous trace is ignored — no reset effect needed).
    const archivedSpans = archived?.traceId === traceId ? archived.spans : undefined;

    // Prefer the live D1 spans; fall back to the archived spans when D1 is empty.
    const displaySpans = spans && spans.length > 0 ? spans : (archivedSpans ?? spans);
    const fromArchive = spans?.length === 0 && (archivedSpans?.length ?? 0) > 0;

    // Hot rollups first, then archived rows the hot window doesn't already carry
    // (dedup by traceId, hot wins) — one seamless, newest-first list.
    const hotIds = new Set((traces ?? []).map((trace) => trace.traceId));
    const archivedRows = (olderTraces ?? []).filter((trace) => !hotIds.has(trace.traceId));
    const rows = [...(traces ?? []), ...archivedRows];

    const selected = rows.find((trace) => trace.traceId === traceId);
    const waterfall = buildTraceTree(displaySpans ?? []);
    const selectedSpan = waterfall.find((span) => span.spanId === selectedSpanId);

    // The longest trace on screen, so each list row's latency bar reads relative to it.
    const maxDuration = Math.max(1, ...rows.map((trace) => trace.durationMs));

    return (
        <div className="stack">
            <section className="card">
                <div className="metrics-head">
                    <h3>Traces</h3>
                    <TimeRangePicker />
                </div>
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
                    <label className="trace-filter">
                        <input
                            checked={errorOnly}
                            onChange={(event) => {
                                setErrorOnly(event.target.checked);
                            }}
                            type="checkbox"
                        />
                        Errors only
                    </label>
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
                            {rows.map((trace) => (
                                <tr
                                    aria-selected={trace.traceId === traceId}
                                    className={`trace-clickable${trace.errorCount > 0 ? " trace-error" : ""}${trace.traceId === traceId ? " active" : ""}`}
                                    key={trace.traceId}
                                    onClick={() => {
                                        setSelectedSpanId("");
                                        setTraceId(trace.traceId === traceId ? "" : trace.traceId);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setSelectedSpanId("");
                                            setTraceId(trace.traceId === traceId ? "" : trace.traceId);
                                        }
                                    }}
                                    tabIndex={0}
                                >
                                    <td className="trace-id">
                                        {trace.traceId.slice(0, 12)}
                                        {hotIds.has(trace.traceId) ? null : <span className="log-badge trace-archive-badge">archive</span>}
                                    </td>
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
                    {rows.length === 0 ? (
                        <p className="muted">
                            No traces yet. Spans arrive as your app handles dispatched requests (or you point an OTel exporter at /v1/traces).
                        </p>
                    ) : null}
                    {/* Seamless deeper history: fold older traces out of the columnar archive
                        for the selected window (fails open to none where no archive is provisioned). */}
                    {olderTraces === undefined ? (
                        <button className="trace-load-older" disabled={loadingOlder} onClick={loadOlderFromArchive} type="button">
                            {loadingOlder ? "Loading…" : "Load older from archive"}
                        </button>
                    ) : archivedRows.length === 0 ? (
                        <p className="muted">No older traces in the archive for this window.</p>
                    ) : null}
                </section>
            ) : null}

            {traceId ? (
                <section className="card">
                    <header className="trace-detail-head">
                        <div>
                            <span className="trace-detail-id">{traceId.slice(0, 16)}</span>
                            {fromArchive ? <span className="log-badge trace-archive-badge">from archive</span> : null}
                            {selected ? (
                                <span className="trace-detail-meta">
                                    {selected.spanCount} spans · {formatMs(selected.durationMs)}
                                    {selected.errorCount > 0 ? <span className="trace-detail-err"> · {selected.errorCount} error</span> : null}
                                </span>
                            ) : null}
                        </div>
                        <div className="trace-detail-actions">
                            <CrossTabLink target="logs" traceId={traceId}>
                                View logs
                            </CrossTabLink>
                            <button
                                className="trace-close"
                                onClick={() => {
                                    setTraceId("");
                                }}
                                type="button"
                            >
                                Close
                            </button>
                        </div>
                    </header>

                    {spans === undefined || (d1Empty && archivedSpans === undefined) ? <p className="muted">Loading…</p> : null}
                    {spans !== undefined && !(d1Empty && archivedSpans === undefined) && (displaySpans?.length ?? 0) === 0 ? (
                        <p className="muted">No spans for this trace in the retention window or the archive.</p>
                    ) : null}

                    <TraceWaterfall
                        onSelect={(spanId) => {
                            setSelectedSpanId(spanId === selectedSpanId ? "" : spanId);
                        }}
                        rows={waterfall}
                        selectedSpanId={selectedSpanId}
                    />

                    {selectedSpan ? (
                        <SpanDetail
                            onClose={() => {
                                setSelectedSpanId("");
                            }}
                            span={selectedSpan}
                        />
                    ) : null}
                </section>
            ) : null}
        </div>
    );
};
