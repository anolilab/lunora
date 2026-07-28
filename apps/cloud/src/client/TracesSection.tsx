import type { ReturnOf } from "@lunora/client";
import { useLunora, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import type { ObservationSpan } from "../telemetry/trace-tree";
import { buildTraceTree } from "../telemetry/trace-tree";
import { CrossTabLink } from "./CrossTabLink";
import { formatMs, formatTime } from "./format";
import { COLUMN_LABEL, Field, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import { TimeRangePicker, useTimeRange } from "./TimeRangeProvider";
import { SpanDetail, TraceWaterfall } from "./TraceDetail";
import type { DeploymentId, ProjectId } from "./types";

/** One rolled-up trace as the list renders it (hot D1 rows and archived rows share the shape). */
type TraceRollup = ReturnOf<typeof api.traces.list>[number];

/**
 * One trace in the list. Extracted so the row's own conditions (failed / archived
 * / selected) live next to the markup they drive rather than inflating the tab.
 *
 * Row hierarchy: latency is the emphasized value — a hairline proportion bar
 * (relative to the longest trace on screen) beside the precise number — while the
 * id, span count and timestamp stay tertiary. Errors tint the latency and the
 * status chip; the row itself is never tinted, and selection is a value step.
 */
const TraceRow = ({
    archived,
    maxDuration,
    onSelect,
    selected,
    trace,
}: {
    archived: boolean;
    maxDuration: number;
    onSelect: () => void;
    selected: boolean;
    trace: TraceRollup;
}): ReactElement => {
    const failed = trace.errorCount > 0;

    return (
        <TableRow
            aria-selected={selected}
            className={cn("cursor-pointer", selected && "bg-muted hover:bg-muted")}
            onClick={onSelect}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect();
                }
            }}
            tabIndex={0}
        >
            <TableCell className="text-muted-foreground font-mono text-xs">
                <span className="flex items-center gap-2">
                    {trace.traceId.slice(0, 12)}
                    {archived ? <StatusBadge>archive</StatusBadge> : null}
                </span>
            </TableCell>
            <TableCell className="font-mono text-xs">{trace.rootFunctionPath ?? trace.rootName}</TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">{trace.spanCount}</TableCell>
            <TableCell>
                <span className="flex min-w-[9rem] items-center gap-2">
                    {/* Proportion (bar) beside precision (number). */}
                    <span aria-hidden className="bg-border h-1 flex-1">
                        <span
                            className={cn("block h-full", failed ? "bg-destructive" : "bg-foreground/70")}
                            style={{ width: `${String(Math.max((trace.durationMs / maxDuration) * 100, 3))}%` }}
                        />
                    </span>
                    <span className={cn("min-w-11 text-end font-mono text-sm tabular-nums", failed && "text-destructive")}>{formatMs(trace.durationMs)}</span>
                </span>
            </TableCell>
            <TableCell>{failed ? <StatusBadge tone="danger">{trace.errorCount} error</StatusBadge> : <StatusBadge tone="success">ok</StatusBadge>}</TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">{formatTime(trace.startedAt)}</TableCell>
        </TableRow>
    );
};

/**
 * The open trace: its waterfall, plus the header that states what the trace cost.
 * Extracted alongside {@link TraceRow} so the span-source fallback (live D1 spans,
 * else the columnar archive) is resolved next to the markup that renders it.
 *
 * Hierarchy: the total duration is the screen's one display-size value — mono,
 * tabular, tinted destructive when the trace carries errors. Trace id, span count
 * and the archive provenance sit beneath it in the mono label voice. A deep-linked
 * trace has no rollup row yet, so its id stands in as the headline until one loads.
 */
const OpenTraceCard = ({
    archivedSpans,
    d1Empty,
    onClose,
    onSelectSpan,
    selected,
    selectedSpanId,
    spans,
    traceId,
}: {
    archivedSpans: ReadonlyArray<ObservationSpan> | undefined;
    d1Empty: boolean;
    onClose: () => void;
    onSelectSpan: (spanId: string) => void;
    selected: TraceRollup | undefined;
    selectedSpanId: string;
    spans: ReadonlyArray<ObservationSpan> | undefined;
    traceId: string;
}): ReactElement => {
    // Prefer the live D1 spans; fall back to the archived spans when D1 is empty.
    const displaySpans = spans && spans.length > 0 ? spans : (archivedSpans ?? spans);
    const fromArchive = spans?.length === 0 && (archivedSpans?.length ?? 0) > 0;
    const waterfall = buildTraceTree(displaySpans ?? []);
    const selectedSpan = waterfall.find((span) => span.spanId === selectedSpanId);
    const loading = spans === undefined || (d1Empty && archivedSpans === undefined);

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>Trace</span>
                    {selected ? (
                        <span className={cn("font-mono text-4xl leading-none tracking-[-0.02em] tabular-nums", selected.errorCount > 0 && "text-destructive")}>
                            {formatMs(selected.durationMs)}
                        </span>
                    ) : (
                        <span className="font-mono text-xl leading-none tracking-[-0.02em]">{traceId.slice(0, 16)}</span>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {selected ? (
                            <>
                                <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>{traceId.slice(0, 16)}</span>
                                <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>{selected.spanCount} spans</span>
                                {selected.errorCount > 0 ? <StatusBadge tone="danger">{selected.errorCount} error</StatusBadge> : null}
                            </>
                        ) : null}
                        {fromArchive ? <StatusBadge>from archive</StatusBadge> : null}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                    <CrossTabLink target="logs" traceId={traceId}>
                        View logs
                    </CrossTabLink>
                    <Button onClick={onClose} size="sm" variant="ghost">
                        Close
                    </Button>
                </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
                {loading ? <p className={cn(COLUMN_LABEL, "text-muted-foreground m-0")}>[Loading…]</p> : null}
                {!loading && (displaySpans?.length ?? 0) === 0 ? (
                    <p className="text-muted-foreground m-0 text-sm">No spans for this trace in the retention window or the archive.</p>
                ) : null}

                <TraceWaterfall
                    onSelect={(spanId) => {
                        onSelectSpan(spanId === selectedSpanId ? "" : spanId);
                    }}
                    rows={waterfall}
                    selectedSpanId={selectedSpanId}
                />

                {selectedSpan ? (
                    <SpanDetail
                        onClose={() => {
                            onSelectSpan("");
                        }}
                        span={selectedSpan}
                    />
                ) : null}
            </CardContent>
        </Card>
    );
};

/**
 * Traces tab — real-duration, nested trace waterfalls over the span store
 * (`observations`), the Langfuse-teardown follow-on. Pick a project, then a
 * deployment; recent dispatch traces render newest-active first (via
 * `traces.list`), each with its real latency bar, span count, and error count.
 * Select one to drill into its **waterfall** (`traces.get` → `buildTraceTree`):
 * every span placed on the trace timeline by its real start + duration and
 * indented by its depth under `parentSpanId` — a true span waterfall, not a
 * log-gap timeline. Both queries are live.
 *
 * Hierarchy: latency is what a trace is read for, so the open trace's total
 * duration is the one value at display size — mono, tabular, tinted destructive
 * when the trace carries errors. In the list each row's latency is the emphasized
 * value (a hairline proportion bar plus the precise number), the root operation
 * is the row's label, and trace ids, span counts and timestamps stay tertiary in
 * the mono label voice. Nothing tints a row: the selected trace is a value step
 * on its background, and errors colour the latency and the status chip only.
 */
export const TracesSection = ({ focusTraceId, organizationId, preloaded }: SectionProps<ReturnOf<typeof api.projects.listByOrg>>): ReactElement => {
    const client = useLunora();
    const { from, to } = useTimeRange();
    const projects = usePreloadedQuery(preloaded);
    // Plain `string`, not `ProjectId | ""`: Base UI's Select is generic over its
    // value and a branded union makes that inference collapse to the empty-string
    // literal. The brand is reapplied at the query boundary, where it means
    // something. Same for the deployment pick below.
    const [projectId, setProjectId] = useState("");
    const deployments = useQuery(api.deployments.listByProject, projectId ? { organizationId, projectId: projectId as ProjectId } : "skip");
    const [deploymentId, setDeploymentId] = useState("");
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

    const traces = useQuery(api.traces.list, deploymentId ? { deploymentId: deploymentId as DeploymentId, errorOnly, from, organizationId, to } : "skip");
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

    // Hot rollups first, then archived rows the hot window doesn't already carry
    // (dedup by traceId, hot wins) — one seamless, newest-first list.
    const hotIds = new Set((traces ?? []).map((trace) => trace.traceId));
    const archivedRows = (olderTraces ?? []).filter((trace) => !hotIds.has(trace.traceId));
    const rows = [...(traces ?? []), ...archivedRows];

    const selected = rows.find((trace) => trace.traceId === traceId);

    // The longest trace on screen, so each list row's latency bar reads relative to it.
    const maxDuration = Math.max(1, ...rows.map((trace) => trace.durationMs));

    /** Open a trace's waterfall, or close it when it is already the open one. */
    const toggleTrace = (id: string): void => {
        setSelectedSpanId("");
        setTraceId(id === traceId ? "" : id);
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <CardTitle>Traces</CardTitle>
                        <CardDescription>Dispatch traces for one deployment over the selected window, newest first.</CardDescription>
                    </div>
                    <TimeRangePicker />
                </CardHeader>
                <CardContent className="flex flex-col gap-4 sm:flex-row sm:gap-6">
                    <Field htmlFor="traces-project" label="Project">
                        <Select
                            onValueChange={(value) => {
                                setProjectId(value ?? "");
                                setDeploymentId("");
                                setTraceId("");
                            }}
                            value={projectId}
                        >
                            <SelectTrigger className="w-full sm:w-72" id="traces-project">
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
                        <Field htmlFor="traces-deployment" label="Deployment">
                            <Select
                                onValueChange={(value) => {
                                    setDeploymentId(value ?? "");
                                    setTraceId("");
                                }}
                                value={deploymentId}
                            >
                                <SelectTrigger className="w-full sm:w-72" id="traces-deployment">
                                    <SelectValue placeholder="Select a deployment…" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {(deployments ?? []).map((deployment) => (
                                            <SelectItem key={deployment._id} value={deployment._id}>
                                                {deployment.scriptName} ({deployment.status})
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </Field>
                    ) : null}
                </CardContent>
            </Card>

            {deploymentId ? (
                <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                        <div className="flex flex-col gap-1.5">
                            <CardTitle>Recent traces</CardTitle>
                            <CardDescription>Select a trace to open its span waterfall.</CardDescription>
                        </div>
                        {/* A pressed toggle rather than a checkbox: the vocabulary has no
                            checkbox primitive, and a segmented on/off control is the
                            design system's shape for a filter. */}
                        <Button
                            aria-pressed={errorOnly}
                            onClick={() => {
                                setErrorOnly((value) => !value);
                            }}
                            size="sm"
                            variant={errorOnly ? "default" : "outline"}
                        >
                            Errors only
                        </Button>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        {rows.length > 0 ? (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className={COLUMN_LABEL}>Trace</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Root operation</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Spans</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Latency</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Started</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((trace) => (
                                        <TraceRow
                                            archived={!hotIds.has(trace.traceId)}
                                            key={trace.traceId}
                                            maxDuration={maxDuration}
                                            onSelect={() => {
                                                toggleTrace(trace.traceId);
                                            }}
                                            selected={trace.traceId === traceId}
                                            trace={trace}
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        ) : (
                            <p className="text-muted-foreground m-0 py-8 text-center text-sm">
                                No traces yet. Spans arrive as your app handles dispatched requests (or you point an OTel exporter at /v1/traces).
                            </p>
                        )}
                        {/* Seamless deeper history: fold older traces out of the columnar archive
                            for the selected window (fails open to none where no archive is provisioned). */}
                        {olderTraces === undefined ? (
                            <Button className="self-start" disabled={loadingOlder} onClick={loadOlderFromArchive} size="sm" variant="outline">
                                {loadingOlder ? "[Loading…]" : "Load older from archive"}
                            </Button>
                        ) : archivedRows.length === 0 ? (
                            <p className={cn(COLUMN_LABEL, "text-muted-foreground m-0")}>No older traces in the archive for this window.</p>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

            {traceId ? (
                <OpenTraceCard
                    archivedSpans={archivedSpans}
                    d1Empty={d1Empty}
                    onClose={() => {
                        setTraceId("");
                    }}
                    onSelectSpan={setSelectedSpanId}
                    selected={selected}
                    selectedSpanId={selectedSpanId}
                    spans={spans}
                    traceId={traceId}
                />
            ) : null}
        </div>
    );
};
