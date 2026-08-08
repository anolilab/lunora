import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import ErrorAlert from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/checkbox";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { LogEntry, LogsResult, TraceSpan, TracesResult, TraceSummary } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import type { PendingTraceFilter } from "../../lib/trace-handoff";
import { clearPendingTraceFilter, peekPendingTraceFilter } from "../../lib/trace-handoff";
import { cn } from "../../lib/utils";
import { LEVEL_VARIANT } from "../logs/log-level-variant";
import SpanDetail from "./span-detail";
import { filterTraces, formatSpanDuration, spanBar, traceTicks } from "./trace-geometry";

/** Pixels of indent per nesting level of a span row. */
const INDENT_PER_DEPTH = 14;

/**
 * Coerce a (possibly partial or malformed) `getTraces` result into its `traces`
 * array. A truncated payload, a live push without the field, or a worker
 * predating the RPC yields `[]` rather than seeding the list with `undefined`.
 */
const tracesOf = (result: TracesResult | undefined): TraceSummary[] => (Array.isArray(result?.traces) ? result.traces : []);

/** Add or remove one id from a set, returning a fresh set so React sees the change. */
const toggled = (previous: ReadonlySet<string>, id: string): ReadonlySet<string> => {
    const next = new Set(previous);

    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }

    return next;
};

interface TraceLogsProps {
    /** Lines emitted under this trace, oldest first. */
    readonly entries: ReadonlyArray<LogEntry>;
}

/**
 * The `ctx.log` lines emitted under one trace, shown beneath its waterfall.
 *
 * This is the drill-down the Traces page was missing: the waterfall says WHICH
 * span was slow or threw, and the log lines say what the code thought it was
 * doing at the time. Both were already on the wire — the log buffer simply
 * dropped the `traceId` that joins them (see `@lunora/observability`'s
 * `LogEntry`), so the two panels could never be put side by side.
 *
 * Read from the same live `getLogs` ring the Logs panel uses, so no extra RPC and
 * no extra retention: a line evicted from that ring disappears here too.
 */
const TraceLogs = ({ entries }: TraceLogsProps): ReactElement => {
    const t = useT();

    return (
        <div className="border-t border-border px-3 py-2" data-testid="tr-logs">
            <p className="mb-1 font-mono text-xs text-muted-foreground">{t("Logs ({count})", { count: entries.length })}</p>
            <div className="flex flex-col gap-1">
                {entries.map((entry) => {
                    const fields = formatLogFields(entry.fields);

                    return (
                        <div className="flex items-start gap-2 font-mono text-xs" data-testid="tr-log-row" key={`${String(entry.timestamp)}:${entry.message}`}>
                            <span className="w-44 shrink-0 tabular-nums text-muted-foreground">{formatTimestamp(entry.timestamp)}</span>
                            <span className="w-16 shrink-0">
                                <Badge variant={LEVEL_VARIANT[entry.level]}>{entry.level}</Badge>
                            </span>
                            <span className="min-w-0 break-all">
                                {entry.message}
                                {fields === "" ? null : <span className="ml-2 text-muted-foreground">{fields}</span>}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

interface TimeRulerProps {
    /** Total duration the ruler annotates, in ms. */
    readonly traceDurationMs: number;
}

/**
 * Elapsed-time gridlines across the waterfall's timeline track, aligned with the
 * span bars' own column so a bar's left edge can be read off a label. Renders
 * nothing for a zero-duration trace, where {@link spanBar} lays every span out
 * full-width and there is no timeline to annotate.
 */
const TimeRuler = ({ traceDurationMs }: TimeRulerProps): ReactElement | null => {
    const ticks = traceTicks(traceDurationMs);

    if (ticks.length === 0) {
        return null;
    }

    return (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 font-mono text-[10px] text-muted-foreground" data-testid="tr-ruler">
            {/* Spacer columns mirroring SpanRow's name cell, so the track below starts at the same x. */}
            <span className="w-56 shrink-0" />
            <span className="relative h-3 flex-1">
                {ticks.map((tick) => (
                    <span className="absolute inset-y-0 border-l border-border/70 pl-1" key={tick.percent} style={{ left: `${String(tick.percent)}%` }}>
                        {tick.label}
                    </span>
                ))}
            </span>
            <span className="w-16 shrink-0" />
            <span className="w-64 shrink-0" />
            <span className="w-64 shrink-0" />
        </div>
    );
};

interface SpanRowProps {
    /** Whether this span's detail block is open. */
    readonly expanded: boolean;
    /** Lifts the per-row click out of the map so the row carries no inline closure. */
    readonly onToggle: (spanId: string) => void;
    readonly span: TraceSpan;
    /** The enclosing trace's total duration, the denominator for the bar geometry. */
    readonly traceDurationMs: number;
}

/**
 * One waterfall row: the span's name indented by its server-computed `depth`, a
 * bar positioned by `offsetMs` and sized by `durationMs`, its duration, its
 * structured attributes, and — when the body threw — an error chip plus message.
 *
 * Clicking the row opens {@link SpanDetail} beneath it. The row's attribute and
 * error cells are hard-truncated to keep the waterfall scannable, so the detail
 * block is the only place the full values are legible.
 */
const SpanRow = ({ expanded, onToggle, span, traceDurationMs }: SpanRowProps): ReactElement => {
    const t = useT();
    const { leftPercent, widthPercent } = spanBar(span, traceDurationMs);

    // Rendered once; `""` (no attributes) skips the chip entirely rather than
    // showing a blank span — the same convention as the Logs panel's fields.
    const attributes = formatLogFields(span.attributes);

    const nameStyle: CSSProperties = { paddingLeft: span.depth * INDENT_PER_DEPTH };
    const barStyle: CSSProperties = { left: `${String(leftPercent)}%`, width: `${String(widthPercent)}%` };

    const onClick = (): void => {
        onToggle(span.spanId);
    };

    return (
        <li data-depth={span.depth} data-testid="tr-span-row">
            <button
                aria-controls={`tr-span-detail-${span.spanId}`}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left font-mono text-xs hover:bg-muted/50"
                data-testid={`tr-span-toggle-${span.spanId}`}
                onClick={onClick}
                type="button"
            >
                <span className="w-56 shrink-0 truncate" style={nameStyle} title={span.name}>
                    {span.ok ? null : (
                        <span aria-label={t("Errored span")} className="mr-1 text-destructive" data-testid="tr-span-error" role="img">
                            ●
                        </span>
                    )}
                    {span.name}
                </span>
                {/*
                 * The bar cell carries no text, so a screen reader would announce
                 * nothing for it. Label it with the waterfall position it encodes —
                 * where in the trace the span starts and how long it ran — which is
                 * otherwise available only visually.
                 */}
                <span
                    aria-label={t("starts {offset} in, runs {duration}", {
                        duration: formatSpanDuration(span.durationMs),
                        offset: formatSpanDuration(span.offsetMs),
                    })}
                    className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted"
                >
                    <span
                        className={cn("absolute inset-y-0 rounded-sm", span.ok ? "bg-primary/70" : "bg-destructive")}
                        data-left={leftPercent}
                        data-testid="tr-span-bar"
                        data-width={widthPercent}
                        style={barStyle}
                    />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatSpanDuration(span.durationMs)}</span>
                {/*
                 * Error and attributes get their own cells rather than sharing one.
                 * Sharing meant a failed span dropped its attributes — hiding
                 * `{ orderId }` on exactly the span you opened the panel to debug.
                 * Both are truncated here; the detail block below prints them whole.
                 */}
                <span className="w-64 shrink-0 truncate text-muted-foreground">
                    {span.error === undefined ? null : (
                        <span className="text-destructive" data-testid="tr-span-error-message" title={span.error.message}>
                            {`${span.error.type}: ${span.error.message}`}
                        </span>
                    )}
                </span>
                <span className="w-64 shrink-0 truncate text-muted-foreground">
                    {attributes === "" ? null : (
                        <span data-testid="tr-span-attributes" title={attributes}>
                            {attributes}
                        </span>
                    )}
                </span>
            </button>

            {expanded && (
                <div id={`tr-span-detail-${span.spanId}`}>
                    <SpanDetail span={span} />
                </div>
            )}
        </li>
    );
};

interface TraceRowProps {
    /** Whether this trace's waterfall is currently expanded. */
    readonly expanded: boolean;
    /** Span ids whose detail block is open, across the whole list. */
    readonly expandedSpans: ReadonlySet<string>;
    /** `ctx.log` lines emitted under this trace, oldest first. Empty when none were captured. */
    readonly logs: ReadonlyArray<LogEntry>;
    /** Lifts the per-row click out of the map so the row carries no inline closure. */
    readonly onToggle: (traceId: string) => void;
    readonly onToggleSpan: (spanId: string) => void;
    readonly trace: TraceSummary;
}

/**
 * One trace in the list: a clickable summary header (root name, function path,
 * total duration, span count, ok/error badge) that expands into the waterfall,
 * the spans' detail blocks, and the log lines the same dispatch emitted.
 */
const TraceRow = ({ expanded, expandedSpans, logs, onToggle, onToggleSpan, trace }: TraceRowProps): ReactElement => {
    const t = useT();

    const onClick = (): void => {
        onToggle(trace.traceId);
    };

    return (
        <div className="border-b border-border last:border-b-0" data-testid={`tr-row-${trace.traceId}`}>
            <button
                aria-controls={`tr-waterfall-${trace.traceId}`}
                aria-expanded={expanded}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50"
                data-testid={`tr-toggle-${trace.traceId}`}
                onClick={onClick}
                type="button"
            >
                <span aria-hidden="true" className="w-3 shrink-0 text-xs text-muted-foreground">
                    {expanded ? "▾" : "▸"}
                </span>
                <span className="w-56 shrink-0 truncate text-sm font-medium" title={trace.rootName}>
                    {trace.rootName}
                </span>
                <span className="w-48 shrink-0 truncate font-mono text-xs text-muted-foreground" title={trace.functionPath}>
                    {trace.functionPath}
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatSpanDuration(trace.durationMs)}</span>
                <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {t("{count} spans", { count: trace.spans.length })}
                </span>
                <span className="shrink-0">
                    <Badge variant={trace.ok ? "secondary" : "destructive"}>{trace.ok ? t("ok") : t("error")}</Badge>
                </span>
                <span className="flex-1 truncate text-right font-mono text-xs tabular-nums text-muted-foreground">{formatTimestamp(trace.startTs)}</span>
            </button>

            {expanded && (
                <div className="bg-muted/20" data-testid={`tr-waterfall-${trace.traceId}`} id={`tr-waterfall-${trace.traceId}`}>
                    <TimeRuler traceDurationMs={trace.durationMs} />
                    <ul aria-label={t("Trace waterfall")}>
                        {trace.spans.map((span) => (
                            <SpanRow
                                expanded={expandedSpans.has(span.spanId)}
                                key={span.spanId}
                                onToggle={onToggleSpan}
                                span={span}
                                traceDurationMs={trace.durationMs}
                            />
                        ))}
                    </ul>
                    {logs.length > 0 && <TraceLogs entries={logs} />}
                </div>
            )}
        </div>
    );
};

interface TracesPanelProps {
    /** Shard key the panel reads traces from. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/**
 * The Traces observability page — recent `ctx.trace` waterfalls for one shard,
 * read over the gated `__lunora_admin__:getTraces` RPC and pushed live over the
 * same admin WebSocket the Logs panel uses, so a fresh dispatch appears without
 * a manual refresh.
 *
 * Traces are the drill-down from a log line: a dispatch's synthetic root span
 * plus every `ctx.trace(name, fn)` span recorded beneath it. The server folds
 * them (`@lunora/do`'s pure `foldTraces`) and stamps each span with a `depth`
 * and an `offsetMs`, so this panel does no tree math — it indents by `depth` and
 * sizes each bar from `offsetMs`/`durationMs` via the pure {@link spanBar} helper.
 *
 * Expanding a trace gives the three things a waterfall alone cannot: an elapsed-time
 * ruler to read a bar's position against, a per-span detail block with the FULL
 * attribute bag / error / recorded span events (the row can only afford a truncated
 * chip), and the `ctx.log` lines the same dispatch emitted, joined by `traceId`
 * from the live log ring.
 *
 * The backing span ring is bounded and in-memory, so it resets on hibernation or
 * restart and a trace can legitimately arrive partial. This is a local-development
 * readout, NOT a durable trace store — production tracing ships to a real
 * collector via the runtime's OTLP sink.
 */
const TracesPanel = ({ initialShardKey }: TracesPanelProps): ReactElement => {
    const t = useT();

    // Apply a one-shot exemplar hand-off (a metric's Trace link): seed the search
    // with the trace id AND switch to the shard it was recorded on, so an exemplar
    // opened from a non-root shard searches the right ring. The read is a PURE peek
    // (no store mutation), so it is safe in a lazy initializer — a render stays pure,
    // and a double-invoked initializer under StrictMode is harmless. The one-shot
    // clear lives in the mount effect below, not here.
    const [pending] = useState<PendingTraceFilter | undefined>(peekPendingTraceFilter);

    const { queryShardKey, setShardKey, shardKey } = useShardKey(
        pending?.shardKey !== undefined && pending.shardKey !== "" ? pending.shardKey : (initialShardKey ?? ""),
    );
    const [search, setSearch] = useState<string>(pending?.traceId ?? "");
    const [onlyErrors, setOnlyErrors] = useState(false);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [expandedSpans, setExpandedSpans] = useState<ReadonlySet<string>>(() => new Set());

    // Consume the hand-off on mount (a committed boundary): clear the store so a
    // later manual visit isn't re-filtered. Clearing needs no setState, so this
    // doesn't trip the set-state-in-effect rule, and keeping it out of render is
    // what lets the peek above stay pure.
    useEffect(() => {
        clearPendingTraceFilter();
    }, []);

    const { data, error, errorSource, isLoading, liveError } = useAdminQuery<TracesResult>(
        ADMIN_FUNCTIONS.getTraces,
        {},
        { live: true, shardKey: queryShardKey },
    );

    // The same live log ring the Logs panel reads, joined to the waterfalls by
    // `traceId`. A second read rather than a new correlated RPC: both rings are
    // already pushed live over this socket, and joining two cheap reads client-side
    // avoids a bespoke server-side join that would only ever serve this panel.
    // Its failure is deliberately NOT surfaced — losing the log ring must degrade
    // the trace detail, never blank the waterfalls the panel exists to show.
    const { data: logsData } = useAdminQuery<LogsResult>(ADMIN_FUNCTIONS.getLogs, {}, { live: true, shardKey: queryShardKey });

    // Record the browsed shard into recent-shards history once the read resolves,
    // so a shard visited here shows up in every other panel's autocomplete —
    // matching the nine other shard-scoped panels.
    useEffect(() => {
        if (data !== undefined) {
            recordShard(queryShardKey);
        }
    }, [data, queryShardKey]);

    const traces = tracesOf(data);
    // The RPC returns only the newest `DEFAULT_TRACE_LIMIT` traces; `total` is how
    // many distinct traces the ring actually holds, so `total > traces.length`
    // means the view is truncated (older traces exist but weren't returned).
    const total = data?.total ?? traces.length;
    const truncated = total > traces.length;
    // The span ring is not a queryable store, so the search runs client-side over
    // the loaded traces (the same model as the Logs panel's Errors view).
    const filtered = filterTraces(traces, search, onlyErrors);

    // Index the log ring by trace once per read rather than scanning it per
    // expanded trace: the ring holds up to 500 entries and every trace row would
    // otherwise re-walk all of them on every render.
    const logsByTrace = useMemo(() => {
        const index = new Map<string, LogEntry[]>();

        // `getLogs` returns newest-first; a trace's own lines read as a narrative,
        // so reverse into chronological order as they are bucketed.
        for (const entry of (logsData?.entries ?? []).toReversed()) {
            if (entry.traceId === undefined) {
                continue;
            }

            const bucket = index.get(entry.traceId);

            if (bucket === undefined) {
                index.set(entry.traceId, [entry]);
            } else {
                bucket.push(entry);
            }
        }

        return index;
    }, [logsData]);

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    // Toggle one trace in/out of the expanded set without mutating the prior set.
    const onToggle = (traceId: string): void => {
        setExpanded((previous) => toggled(previous, traceId));
    };

    const onToggleSpan = (spanId: string): void => {
        setExpandedSpans((previous) => toggled(previous, spanId));
    };

    // A count of 0 while the first read is still in flight means the ring hasn't
    // loaded yet, not that the shard returned nothing — don't flash the empty state.
    const showEmpty = error === null && filtered.length === 0 && !isLoading;

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-traces-panel">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="tr-shard-input" value={shardKey} />
                <Input
                    aria-label={t("Search traces")}
                    className="h-8 w-56"
                    data-testid="tr-search"
                    onChange={onSearchChange}
                    placeholder={t("search trace, span, or function")}
                    value={search}
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="tr-only-errors">
                    <Checkbox checked={onlyErrors} data-testid="tr-only-errors" id="tr-only-errors" onCheckedChange={setOnlyErrors} />
                    {t("Errors only")}
                </label>
                <LiveError message={liveError} prefix="tr" />
            </div>

            {error !== null && <ErrorAlert error={errorSource} testId="tr-error" />}

            {showEmpty && (
                <EmptyState
                    description={t(
                        "Traces recorded with ctx.trace show up here as your app handles traffic. The span buffer resets when the shard hibernates.",
                    )}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 6h10M7 12h13M10 18h7" />
                        </svg>
                    }
                    testId="tr-empty"
                    title={t("No traces")}
                />
            )}

            {error === null && truncated && (
                <p className="text-xs text-muted-foreground" data-testid="tr-truncated">
                    {t("Showing the {shown} most recent of {total} traces in the buffer.", { shown: traces.length, total })}
                </p>
            )}

            {error === null && filtered.length > 0 && (
                <div aria-label={t("Recent traces")} className="overflow-hidden rounded-xl border border-border shadow-xs" data-testid="tr-list">
                    {filtered.map((trace) => (
                        <TraceRow
                            expanded={expanded.has(trace.traceId)}
                            expandedSpans={expandedSpans}
                            key={trace.traceId}
                            logs={logsByTrace.get(trace.traceId) ?? []}
                            onToggle={onToggle}
                            onToggleSpan={onToggleSpan}
                            trace={trace}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
export default TracesPanel;
