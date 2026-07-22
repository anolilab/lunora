import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { OrgId, ProjectId } from "./types";

interface LogsSectionProps {
    /** Deep-link in: prefilter the log lines to this trace (from a trace's "View logs"). */
    focusTraceId?: string;
    /** Deep-link out: jump to a line's trace waterfall. */
    onOpenTab?: (tab: "logs" | "traces", context?: { traceId?: string }) => void;
    organizationId: OrgId;
}

/** The seven-tier `ctx.log` severity ramp, ordered least→most severe for the filter chips. */
type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

const ALL_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "log", "warn", "error", "fatal"];

/** Render a structured fields bag as compact, space-joined `key=value` pairs. */
const renderFields = (fields: Record<string, unknown>): string =>
    Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ");

/**
 * Logs tab (GAPS.md B2) — full log management. Pick a project, then a deployment;
 * the tenant runtime lines (tail-worker ingested) render newest-first with their
 * full shape: a severity chip, the emitting function, the message, structured
 * `fields`, and a short trace id linking the line to its dispatch trace. Filter
 * by severity (chips) and free-text search (message / function / field values);
 * both push to the server-side `logs.list`. The query is live, so the view tails
 * on its own — no polling.
 */
export const LogsSection = ({ focusTraceId, onOpenTab, organizationId }: LogsSectionProps): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const [projectId, setProjectId] = useState<ProjectId | "">("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId } : "skip");
    const [scriptName, setScriptName] = useState("");
    const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
    const [search, setSearch] = useState("");
    const [traceFilter, setTraceFilter] = useState<string | undefined>(focusTraceId);

    // Deep-link in: adopt an incoming trace filter (from a trace's "View logs").
    useEffect(() => {
        if (focusTraceId) {
            setTraceFilter(focusTraceId);
        }
    }, [focusTraceId]);

    const logs = useQuery(
        api.logs.list,
        scriptName
            ? {
                  levels: levels.size > 0 ? [...levels] : undefined,
                  organizationId,
                  scriptName,
                  search: search.trim() === "" ? undefined : search.trim(),
                  traceId: traceFilter,
              }
            : "skip",
    );

    const toggleLevel = (level: LogLevel): void => {
        setLevels((previous) => {
            const next = new Set(previous);

            if (next.has(level)) {
                next.delete(level);
            } else {
                next.add(level);
            }

            return next;
        });
    };

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
                    {traceFilter ? (
                        <div className="log-trace-filter">
                            Filtering by trace <code>{traceFilter.slice(0, 12)}</code>
                            <button className="trace-link" onClick={() => setTraceFilter(undefined)} type="button">
                                clear
                            </button>
                        </div>
                    ) : null}
                    <div className="log-toolbar">
                        <input
                            aria-label="Search logs"
                            className="log-search"
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search message, function, or field values…"
                            type="search"
                            value={search}
                        />
                        <div className="log-levels" role="group">
                            {ALL_LEVELS.map((level) => (
                                <button
                                    aria-pressed={levels.has(level)}
                                    className={`log-chip log-chip-${level}${levels.has(level) ? " active" : ""}`}
                                    key={level}
                                    onClick={() => toggleLevel(level)}
                                    type="button"
                                >
                                    {level}
                                </button>
                            ))}
                        </div>
                    </div>

                    <pre className="log-view">
                        {(logs ?? []).map((entry, index) => (
                            <span className={`log-line log-line-${entry.level}`} key={`${String(entry.createdAt)}-${String(index)}`}>
                                <span className="log-time">[{new Date(entry.createdAt).toLocaleTimeString()}]</span>{" "}
                                <span className={`log-badge log-badge-${entry.level}`}>{entry.level}</span>{" "}
                                {entry.functionPath ? <span className="log-fn">{entry.functionPath}</span> : null} {entry.message}
                                {entry.fields ? <span className="log-fields"> {renderFields(entry.fields)}</span> : null}
                                {entry.traceId ? (
                                    onOpenTab ? (
                                        <button className="log-trace-link" onClick={() => onOpenTab("traces", { traceId: entry.traceId })} type="button">
                                            trace={entry.traceId.slice(0, 8)}
                                        </button>
                                    ) : (
                                        <span className="log-trace"> trace={entry.traceId.slice(0, 8)}</span>
                                    )
                                ) : null}
                                {"\n"}
                            </span>
                        ))}
                        {logs?.length === 0 ? "No matching log lines in the retention window." : null}
                    </pre>
                </section>
            ) : null}
        </div>
    );
};
