import type { ChangeEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

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
import type { LogEntry, LogsResult, TracesResult, TraceSummary } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { formatTimestamp } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import type { PendingTraceFilter } from "../../lib/trace-handoff";
import { clearPendingTraceFilter, peekPendingTraceFilter } from "../../lib/trace-handoff";
import LogLine from "../logs/log-line";
import { filterTraces, formatSpanDuration } from "./trace-geometry";
import TraceWaterfall from "./trace-waterfall";

/**
 * Coerce a (possibly partial or malformed) `getTraces` result into its `traces`
 * array. A truncated payload, a live push without the field, or a worker
 * predating the RPC yields `[]` rather than seeding the list with `undefined`.
 */
const tracesOf = (result: TracesResult | undefined): TraceSummary[] => (Array.isArray(result?.traces) ? result.traces : []);

interface TraceLogsProps {
    /** Lines emitted under this trace, oldest first. */
    readonly entries: ReadonlyArray<LogEntry>;
}

/**
 * The `ctx.log` lines emitted under one trace, shown beneath its waterfall — the
 * waterfall says WHICH span was slow or threw, these say what the code thought
 * it was doing at the time.
 *
 * Read from the same live `getLogs` ring the Logs panel uses, so no extra RPC and
 * no extra retention: a line evicted from that ring disappears here too.
 */
const TraceLogs = ({ entries }: TraceLogsProps): ReactElement => {
    const t = useT();

    return (
        <div className="border-t border-border px-3 py-2" data-testid="tr-logs">
            <p className="mb-1 font-mono text-xs text-muted-foreground">{t("Logs ({count})", { count: entries.length })}</p>
            <div role="grid">
                {/*
                 * Keyed by position, not by content: two identical messages logged
                 * in the same millisecond are ordinary (a retry loop) and would
                 * collide on any content-derived key. The bucket is rebuilt whole
                 * from an append-only ring per render, so an index is stable.
                 */}
                {entries.map((entry, index) => (
                    <div
                        className="flex items-center border-b border-border py-1 font-mono text-xs last:border-b-0"
                        data-testid="tr-log-row"
                        key={`${String(index)}:${String(entry.timestamp)}`}
                        role="row"
                    >
                        <LogLine entry={entry} />
                    </div>
                ))}
            </div>
        </div>
    );
};

interface TraceRowProps {
    /** Whether this trace's waterfall is currently expanded. */
    readonly expanded: boolean;
    /** `ctx.log` lines emitted under this trace, oldest first. Empty when none were captured. */
    readonly logs: ReadonlyArray<LogEntry>;
    /** Lifts the per-row click out of the map so the row carries no inline closure. */
    readonly onToggle: (traceId: string) => void;
    readonly trace: TraceSummary;
}

/**
 * One trace in the list: a clickable summary header (root name, function path,
 * total duration, span count, ok/error badge) that expands into the waterfall
 * and the log lines the same dispatch emitted.
 */
const TraceRow = ({ expanded, logs, onToggle, trace }: TraceRowProps): ReactElement => {
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
                    <TraceWaterfall durationMs={trace.durationMs} spans={trace.spans} />
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
 * and an `offsetMs`, so nothing here does tree math — see `trace-waterfall.tsx`.
 *
 * Expanding a trace also brings up the `ctx.log` lines the same dispatch emitted,
 * joined by `traceId` from the live log ring.
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
    // `traceId` — a client-side join of two reads already pushed over this socket,
    // rather than a bespoke server-side join that would only ever serve this panel.
    //
    // Gated on an open trace: the log section renders only inside an expanded row,
    // so an unconditional read would open a second live subscription and stream the
    // whole ring on every visit to a page that starts fully collapsed. Its failure
    // is deliberately not surfaced — losing the log ring must degrade the trace
    // detail, never blank the waterfalls the panel exists to show.
    const { data: logsData } = useAdminQuery<LogsResult>(ADMIN_FUNCTIONS.getLogs, {}, { enabled: expanded.size > 0, live: true, shardKey: queryShardKey });

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

    // `getLogs` is newest-first; a trace's own lines read as a narrative, so
    // reverse into chronological order before bucketing. Untraced lines land in an
    // `undefined` bucket that no lookup can reach, which is the correct home.
    const logsByTrace = Map.groupBy((logsData?.entries ?? []).toReversed(), (entry) => entry.traceId);

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
                            key={trace.traceId}
                            logs={logsByTrace.get(trace.traceId) ?? []}
                            onToggle={onToggle}
                            trace={trace}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
export default TracesPanel;
