import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import { CrossTabLink } from "./CrossTabLink";
import { formatTime } from "./format";
import { COLUMN_LABEL, Field } from "./section-ui";
import type { SectionProps } from "./tabs";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import type { ProjectId } from "./types";

/** The seven-tier `ctx.log` severity ramp, ordered least→most severe for the filter chips. */
type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

const ALL_LEVELS: ReadonlyArray<LogLevel> = ["trace", "debug", "info", "log", "warn", "error", "fatal"];

/**
 * Severity → the colour the LINE carries. Tints the value, never a row
 * background: a console stays a console, and the ramp is the same one the
 * legacy stylesheet used (fatal/error red, warn amber, trace/debug receded,
 * info/log at full contrast).
 */
const LEVEL_CLASS: Record<LogLevel, string> = {
    debug: "text-muted-foreground",
    error: "text-destructive",
    fatal: "text-destructive",
    info: "",
    log: "",
    trace: "text-muted-foreground",
    warn: "text-warning",
};

/** Widest severity word in {@link ALL_LEVELS} — pads the column so lines stay aligned. */
const LEVEL_WIDTH = 5;

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
 *
 * Hierarchy: the console IS the screen, so it is the one element rendered at size
 * — a tall mono block on a surface step (mechanical honesty: a log viewer should
 * look like a log viewer). The toolbar (search + severity chips) is secondary
 * supporting chrome, and everything on a line except the message — timestamp,
 * severity word, function path, fields, trace link — is tertiary mono at reduced
 * contrast, so the eye lands on the message first and the severity colour second.
 */
export const LogsSection = ({ focusTraceId, organizationId, preloaded }: SectionProps<ReturnOf<typeof api.projects.listByOrg>>): ReactElement => {
    const { from, to } = useTimeRange();
    const projects = usePreloadedQuery(preloaded);
    // Plain `string`, not `ProjectId | ""`: Base UI's Select is generic over its value
    // and a branded union makes that inference collapse to the empty-string literal.
    // The brand is reapplied at the query boundary, which is where it means something.
    const [projectId, setProjectId] = useState("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId: projectId as ProjectId } : "skip");
    const [scriptName, setScriptName] = useState("");
    const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
    const [search, setSearch] = useState("");
    // Deep-link in: adopt an incoming trace filter (from a trace's "View logs") as a
    // one-shot state seed, so the user can then clear or change it freely.
    //
    // The invariant this relies on is the route's `key={traceId}` (see
    // `src/routes/_authed.orgs.$organizationId.logs.tsx`), which remounts the section
    // whenever `?traceId=` changes. It is NOT the old dashboard's `seq` counter —
    // that was deleted with the SPA shell — and it is not free: the router alone
    // remounts on a route change, not on a search-param change, so removing that
    // `key` silently reintroduces a filter that outlives the URL.
    const [traceFilter, setTraceFilter] = useState<string | undefined>(focusTraceId);

    const logs = useQuery(
        api.logs.list,
        scriptName
            ? {
                  from,
                  levels: levels.size > 0 ? [...levels] : undefined,
                  organizationId,
                  scriptName,
                  search: search.trim() === "" ? undefined : search.trim(),
                  to,
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
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Runtime logs</CardTitle>
                    <CardDescription>
                        Console output your deployments emitted through <code className="font-mono text-xs">ctx.log</code>, tailed live over the selected
                        window.
                    </CardDescription>
                    <CardAction>
                        <TimeRangePicker />
                    </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 sm:flex-row sm:gap-6">
                    <Field htmlFor="logs-project" label="Project">
                        <Select
                            onValueChange={(value) => {
                                setProjectId(value ?? "");
                                setScriptName("");
                            }}
                            value={projectId}
                        >
                            <SelectTrigger className="w-full sm:w-64" id="logs-project">
                                <SelectValue placeholder="Select a project…" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {(projects ?? []).map((project) => (
                                        <SelectItem key={project._id} value={project._id}>
                                            {project.name}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>

                    {projectId ? (
                        <Field htmlFor="logs-deployment" label="Deployment">
                            <Select
                                onValueChange={(value) => {
                                    setScriptName(value ?? "");
                                }}
                                value={scriptName}
                            >
                                <SelectTrigger className="w-full sm:w-72" id="logs-deployment">
                                    <SelectValue placeholder="Select a deployment…" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {(deployments ?? []).map((deployment) => (
                                            <SelectItem key={deployment._id} value={deployment.scriptName}>
                                                <span className="font-mono">{deployment.scriptName}</span>
                                                <span className="text-muted-foreground">{deployment.status}</span>
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </Field>
                    ) : null}
                </CardContent>
            </Card>

            {scriptName ? (
                <Card>
                    <CardHeader className="gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                aria-label="Search logs"
                                className="w-full sm:w-80"
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                }}
                                placeholder="Search message, function, or field values…"
                                type="search"
                                value={search}
                            />
                            {/* Segmented severity filter: active = inverted, inactive = hairline outline. */}
                            <div aria-label="Severity" className="flex flex-wrap gap-1" role="group">
                                {ALL_LEVELS.map((level) => (
                                    <Button
                                        aria-pressed={levels.has(level)}
                                        className={`${COLUMN_LABEL} px-2`}
                                        key={level}
                                        onClick={() => {
                                            toggleLevel(level);
                                        }}
                                        size="xs"
                                        type="button"
                                        variant={levels.has(level) ? "default" : "outline"}
                                    >
                                        {level}
                                    </Button>
                                ))}
                            </div>
                        </div>

                        {traceFilter ? (
                            <div className="text-muted-foreground flex items-center gap-2 font-mono text-[11px]">
                                <span className={COLUMN_LABEL}>Trace filter</span>
                                <span className="text-foreground">{traceFilter.slice(0, 12)}</span>
                                <Button
                                    onClick={() => {
                                        setTraceFilter(undefined);
                                    }}
                                    size="xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    Clear
                                </Button>
                            </div>
                        ) : null}
                    </CardHeader>
                    <CardContent>
                        {/* The screen's primary layer: the stream itself, at size, on one surface step. */}
                        <pre className="bg-muted/40 max-h-[36rem] overflow-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                            {(logs ?? []).map((entry, index) => (
                                <span className={`block ${LEVEL_CLASS[entry.level]}`} key={`${String(entry.createdAt)}-${String(index)}`}>
                                    <span className="text-muted-foreground">{formatTime(entry.createdAt)}</span>{" "}
                                    {/* The severity word inherits the line's tint — it IS the signal. */}
                                    <span>{entry.level.toUpperCase().padEnd(LEVEL_WIDTH)}</span>{" "}
                                    {entry.functionPath ? <span className="text-muted-foreground">{entry.functionPath}</span> : null} {entry.message}
                                    {entry.fields ? <span className="text-muted-foreground"> {renderFields(entry.fields)}</span> : null}
                                    {entry.traceId ? (
                                        <CrossTabLink target="traces" traceId={entry.traceId} variant="inline">
                                            trace={entry.traceId.slice(0, 8)}
                                        </CrossTabLink>
                                    ) : null}
                                </span>
                            ))}
                            {logs === undefined ? <span className={`${COLUMN_LABEL} text-muted-foreground`}>[Loading…]</span> : null}
                            {logs?.length === 0 ? <span className="text-muted-foreground">No matching log lines in the retention window.</span> : null}
                        </pre>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
