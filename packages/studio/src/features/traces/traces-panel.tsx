import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { TraceSpan, TraceSummary, TracesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import { filterTraces, formatSpanDuration, spanBar } from "./trace-geometry";
// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";

/** Pixels of indent per nesting level of a span row. */
const INDENT_PER_DEPTH = 14;

/**
 * Coerce a (possibly partial or malformed) `getTraces` result into its `traces`
 * array. A truncated payload, a live push without the field, or a worker
 * predating the RPC yields `[]` rather than seeding the list with `undefined`.
 */
const tracesOf = (result: TracesResult | undefined): TraceSummary[] => (Array.isArray(result?.traces) ? result.traces : []);

interface SpanRowProps {
    readonly span: TraceSpan;
    /** The enclosing trace's total duration, the denominator for the bar geometry. */
    readonly traceDurationMs: number;
}

/**
 * One waterfall row: the span's name indented by its server-computed `depth`, a
 * bar positioned by `offsetMs` and sized by `durationMs`, its duration, its
 * structured attributes, and — when the body threw — an error chip plus message.
 */
const SpanRow = ({ span, traceDurationMs }: SpanRowProps): ReactElement => {
    const t = useT();
    const { leftPercent, widthPercent } = spanBar(span, traceDurationMs);

    // Rendered once; `""` (no attributes) skips the chip entirely rather than
    // showing a blank span — the same convention as the Logs panel's fields.
    const attributes = formatLogFields(span.attributes);

    const nameStyle: CSSProperties = { paddingLeft: span.depth * INDENT_PER_DEPTH };
    const barStyle: CSSProperties = { left: `${String(leftPercent)}%`, width: `${String(widthPercent)}%` };

    return (
        <div
            className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-xs last:border-b-0 hover:bg-muted/50"
            data-depth={span.depth}
            data-testid="tr-span-row"
            role="row"
        >
            <span className="w-56 shrink-0 truncate" role="gridcell" style={nameStyle} title={span.name}>
                {span.ok ? null : (
                    <span aria-label={t("Errored span")} className="mr-1 text-destructive" data-testid="tr-span-error" role="img">
                        ●
                    </span>
                )}
                {span.name}
            </span>
            <span className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted" role="gridcell">
                <span
                    className={cn("absolute inset-y-0 rounded-sm", span.ok ? "bg-primary/70" : "bg-destructive")}
                    data-left={leftPercent}
                    data-testid="tr-span-bar"
                    data-width={widthPercent}
                    style={barStyle}
                />
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground" role="gridcell">
                {formatSpanDuration(span.durationMs)}
            </span>
            {/*
             * Error and attributes get their own cells rather than sharing one.
             * Sharing meant a failed span dropped its attributes — hiding
             * `{ orderId }` on exactly the span you opened the panel to debug.
             */}
            <span className="w-64 shrink-0 truncate text-muted-foreground" role="gridcell">
                {span.error === undefined ? null : (
                    <span className="text-destructive" data-testid="tr-span-error-message" title={span.error.message}>
                        {`${span.error.type}: ${span.error.message}`}
                    </span>
                )}
            </span>
            <span className="w-64 shrink-0 truncate text-muted-foreground" role="gridcell">
                {attributes === "" ? null : (
                    <span data-testid="tr-span-attributes" title={attributes}>
                        {attributes}
                    </span>
                )}
            </span>
        </div>
    );
};

interface TraceRowProps {
    /** Whether this trace's waterfall is currently expanded. */
    readonly expanded: boolean;
    /** Lifts the per-row click out of the map so the row carries no inline closure. */
    readonly onToggle: (traceId: string) => void;
    readonly trace: TraceSummary;
}

/**
 * One trace in the list: a clickable summary header (root name, function path,
 * total duration, span count, ok/error badge) that expands into the waterfall.
 */
const TraceRow = ({ expanded, onToggle, trace }: TraceRowProps): ReactElement => {
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
                <div
                    aria-label={t("Trace waterfall")}
                    className="bg-muted/20"
                    data-testid={`tr-waterfall-${trace.traceId}`}
                    id={`tr-waterfall-${trace.traceId}`}
                    role="grid"
                >
                    {trace.spans.map((span) => (
                        <SpanRow key={span.spanId} span={span} traceDurationMs={trace.durationMs} />
                    ))}
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
 * The backing span ring is bounded and in-memory, so it resets on hibernation or
 * restart and a trace can legitimately arrive partial. This is a local-development
 * readout, NOT a durable trace store — production tracing ships to a real
 * collector via the runtime's OTLP sink.
 */
export const TracesPanel = ({ initialShardKey }: TracesPanelProps): ReactElement => {
    const t = useT();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [search, setSearch] = useState<string>("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

    // Debounced so typing a key settles before refetching (and re-subscribing)
    // rather than firing per keystroke — mirrors the Logs and Issues panels.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    const { data, error, errorSource, isLoading, liveError } = useAdminQuery<TracesResult>(
        ADMIN_FUNCTIONS.getTraces,
        {},
        { live: true, shardKey: debouncedShard },
    );

    // Record the browsed shard into recent-shards history once the read resolves,
    // so a shard visited here shows up in every other panel's autocomplete —
    // matching the nine other shard-scoped panels.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- recording the browsed shard is derived from the resolved read (a value, not a discrete event); writing it when the data lands is the correct pattern.
        if (data !== undefined) {
            recordShard(debouncedShard);
        }
    }, [data, debouncedShard]);

    const traces = tracesOf(data);
    // The RPC returns only the newest `DEFAULT_TRACE_LIMIT` traces; `total` is how
    // many distinct traces the ring actually holds, so `total > traces.length`
    // means the view is truncated (older traces exist but weren't returned).
    const total = data?.total ?? traces.length;
    const truncated = total > traces.length;
    // The span ring is not a queryable store, so the search runs client-side over
    // the loaded traces (the same model as the Logs panel's Errors view).
    const filtered = filterTraces(traces, search);

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    // Toggle one trace in/out of the expanded set without mutating the prior set.
    const onToggle = (traceId: string): void => {
        setExpanded((previous) => {
            const next = new Set(previous);

            if (next.has(traceId)) {
                next.delete(traceId);
            } else {
                next.add(traceId);
            }

            return next;
        });
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
                    placeholder={t("search trace or function")}
                    value={search}
                />
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
                        <TraceRow expanded={expanded.has(trace.traceId)} key={trace.traceId} onToggle={onToggle} trace={trace} />
                    ))}
                </div>
            )}
        </div>
    );
};
