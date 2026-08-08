import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LOG_LEVEL_ORDER } from "../../../../../shared/log-event";
// Bundler-inlined, zero-dep `key=value` field renderer and severity ordering
// shared with the runtime sinks and the dev-terminal formatter (see CLAUDE.md
// `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import ErrorAlert from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { LogEntry, LogLevel, RequestLogEntry, RequestLogQuery, RequestOutcome } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { recordShard } from "../../lib/shard-history";
import { writePendingTraceFilter } from "../../lib/trace-handoff";
import flooredRectObserver from "../../lib/virtual-rect";
import { ArchiveFeed } from "./archive-feed";
import type { BadgeVariant } from "./log-level-variant";
import { LEVEL_VARIANT } from "./log-level-variant";
import LogsErrorFilters from "./logs-error-filters";
import LogsRequestFilters from "./logs-request-filters";
import type { LogSummary, SummaryBucket } from "./logs-summary";
import { LogsSummary } from "./logs-summary";
import type { LogsView } from "./logs-view-bar";
import { LogsViewBar } from "./logs-view-bar";

/** Fixed height of the scroll viewport; bounds how many rows can be live at once. */
const SCROLL_HEIGHT = 400;

/** Estimated height of a single virtualized log row. */
const ROW_HEIGHT = 36;

/** Static style for the scrollable viewport (bounded height + overflow). */
const SCROLL_STYLE: CSSProperties = { height: SCROLL_HEIGHT, overflow: "auto" };

/** Static base style for an absolutely-positioned virtualized row. */
const ROW_BASE_STYLE: CSSProperties = {
    left: 0,
    position: "absolute",
    top: 0,
    width: "100%",
};

/** Tone per request outcome — an `error` reads as the most alarming. */
const OUTCOME_VARIANT: Record<RequestOutcome, BadgeVariant> = {
    error: "destructive",
    ok: "secondary",
};

interface LogRowProps {
    readonly entry: LogEntry;
    readonly index: number;
    /** react-virtual's ref-callback that measures the rendered row. */
    readonly measureRef: (node: HTMLDivElement | null) => void;
    /** Open the Traces panel filtered to this line's trace. */
    readonly onOpenTrace: (traceId: string) => void;
    /** Pixel offset of this row from the top of the virtualized list. */
    readonly start: number;
}

/**
 * One absolutely-positioned virtualized log row. Extracted into its own
 * component so its per-row `style` (which carries the dynamic `translateY`
 * offset) is a `useMemo`-stable reference — keeping the hot map body free of
 * fresh inline objects.
 */
const LogRow = ({ entry, index, measureRef, onOpenTrace, start }: LogRowProps): ReactElement => {
    const t = useT();
    const style = { ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` };
    // Rendered once; `""` (no fields, or an empty bag from a worker predating
    // field normalization) skips the chip entirely rather than showing a blank span.
    const fields = formatLogFields(entry.fields);
    const { traceId } = entry;

    const onTraceClick = (): void => {
        if (traceId !== undefined) {
            onOpenTrace(traceId);
        }
    };

    return (
        <div
            className="flex items-center border-b border-border px-3 py-1.5 font-mono text-xs hover:bg-muted/50"
            data-index={index}
            data-testid="lg-row"
            ref={measureRef}
            role="row"
            style={style}
        >
            <span className="w-44 shrink-0 tabular-nums text-muted-foreground" role="gridcell">
                {new Date(entry.timestamp).toLocaleString()}
            </span>
            <span className="w-20 shrink-0" role="gridcell">
                <Badge variant={LEVEL_VARIANT[entry.level]}>{entry.level}</Badge>
            </span>
            <span className="w-48 shrink-0 truncate text-muted-foreground" role="gridcell">
                {entry.functionPath ?? "—"}
            </span>
            <span className="flex-1 truncate" role="gridcell">
                {entry.message}
                {fields === "" ? null : (
                    <span className="ml-2 text-muted-foreground" data-testid="lg-fields">
                        {fields}
                    </span>
                )}
            </span>
            {/*
             * The drill-down the two panels were missing: a line emitted inside a
             * dispatch knows its trace, so it can hand you the waterfall it came
             * from instead of leaving you to match timestamps by eye. Absent for
             * lines with no ambient trace (container lifecycle, hibernation errors)
             * and for any worker predating the buffered `traceId`.
             */}
            <span className="w-16 shrink-0 text-right" role="gridcell">
                {traceId === undefined ? null : (
                    <button className="text-primary underline-offset-2 hover:underline" data-testid="lg-trace-link" onClick={onTraceClick} type="button">
                        {t("Trace")}
                    </button>
                )}
            </span>
        </div>
    );
};

interface RequestRowProps {
    readonly entry: RequestLogEntry;
    readonly index: number;
    readonly measureRef: (node: HTMLDivElement | null) => void;
    readonly start: number;
}

/** Join a touched-table list for the compact cell, or an em-dash when none. */
const tablesLabel = (tables: string[]): string => (tables.length === 0 ? "—" : tables.join(", "));

/**
 * One virtualized request-log row. Renders the correlated columns the durable
 * log adds over the in-memory error buffer: function path, shard, acting user,
 * outcome, duration, and the read/written table sets.
 */
const RequestRow = ({ entry, index, measureRef, start }: RequestRowProps): ReactElement => {
    const style = { ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` };

    return (
        <div
            className="flex items-center border-b border-border px-3 py-1.5 font-mono text-xs hover:bg-muted/50"
            data-index={index}
            data-testid="lg-req-row"
            ref={measureRef}
            role="row"
            style={style}
        >
            <span className="w-40 shrink-0 tabular-nums text-muted-foreground" role="gridcell">
                {new Date(entry.ts).toLocaleString()}
            </span>
            <span className="w-16 shrink-0" role="gridcell">
                <Badge variant={OUTCOME_VARIANT[entry.outcome]}>{entry.outcome}</Badge>
            </span>
            <span className="w-44 shrink-0 truncate" role="gridcell" title={entry.functionPath}>
                {entry.functionPath}
            </span>
            <span className="w-24 shrink-0 truncate text-muted-foreground" role="gridcell">
                {entry.shardKey ?? "—"}
            </span>
            <span className="w-24 shrink-0 truncate text-muted-foreground" role="gridcell">
                {entry.userId ?? "—"}
            </span>
            <span className="w-16 shrink-0 tabular-nums text-muted-foreground" role="gridcell">
                {`${String(Math.round(entry.durationMs))}ms`}
            </span>
            <span className="flex-1 truncate text-muted-foreground" role="gridcell">
                {entry.outcome === "error" && entry.errorMessage !== undefined
                    ? entry.errorMessage
                    : `r:${tablesLabel(entry.tablesRead)} · w:${tablesLabel(entry.tablesWritten)}`}
            </span>
        </div>
    );
};

interface LogsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/**
 * Coerce a (possibly partial or malformed) admin result into its `entries`
 * array. A one-shot read or live push that arrives without an `entries` array —
 * a truncated payload, or a worker predating the field — yields `[]` rather than
 * seeding the buffer with `undefined`, which the downstream row count would crash on.
 */
const entriesOf = <T,>(result: unknown): T[] => {
    const { entries } = (result ?? {}) as { entries?: unknown };

    return Array.isArray(entries) ? (entries as T[]) : [];
};

/** Which feed the panel shows: the durable per-request log, or the in-memory error buffer. */

/**
 * Build the server-side `getRequestLog` filter args, dropping empty fields so an
 * untouched control never narrows the read.
 */
const buildRequestQuery = (filters: {
    functionPathPrefix: string;
    outcome: string;
    tableTouched: string;
    userId: string;
}): Record<string, unknown> & RequestLogQuery => {
    const query: Record<string, unknown> & RequestLogQuery = {};

    if (filters.functionPathPrefix.trim() !== "") {
        query.functionPathPrefix = filters.functionPathPrefix.trim();
    }

    if (filters.userId.trim() !== "") {
        query.userId = filters.userId.trim();
    }

    if (filters.tableTouched.trim() !== "") {
        query.tableTouched = filters.tableTouched.trim();
    }

    if (filters.outcome === "ok" || filters.outcome === "error") {
        query.outcome = filters.outcome;
    }

    return query;
};

/** A relative time-range window over the Errors buffer, or `all` (no bound). */
type TimeRange = "15m" | "1h" | "5m" | "all";

/** Window length in ms for each bounded {@link TimeRange}; `all` is unbounded. */
const TIME_RANGE_MS: Record<Exclude<TimeRange, "all">, number> = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
};

/**
 * Composed, AND-ed client-side filter criteria over the in-memory Errors buffer.
 * `levels` is an allow-set (empty = no level constraint); `path` and `search`
 * are case-insensitive substrings; `range` is bounded relative to `now`.
 */
interface LogFilterCriteria {
    readonly levels: ReadonlySet<LogLevel>;
    /** Reference instant the time window is measured back from (epoch-ms). */
    readonly now: number;
    /** Case-insensitive substring over `functionPath`. */
    readonly path: string;
    readonly range: TimeRange;
    /** Case-insensitive substring over `message`. */
    readonly search: string;
}

/**
 * Pure, AND-composed filter over the loaded log entries. Lunora's `getLogs` is
 * an in-memory ring buffer, not a queryable store, so there is no SQL to run —
 * this is the client-side equivalent: level allow-set, function-path substring,
 * message substring, and a relative time window, all combined. Extracted to
 * module scope so it is unit-testable in isolation.
 */
const filterLogs = (entries: ReadonlyArray<LogEntry>, criteria: LogFilterCriteria): LogEntry[] => {
    const needle = criteria.search.trim().toLowerCase();
    const pathNeedle = criteria.path.trim().toLowerCase();
    const floor = criteria.range === "all" ? Number.NEGATIVE_INFINITY : criteria.now - TIME_RANGE_MS[criteria.range];

    return entries.filter((entry) => {
        if (criteria.levels.size > 0 && !criteria.levels.has(entry.level)) {
            return false;
        }

        if (entry.timestamp < floor) {
            return false;
        }

        if (pathNeedle !== "" && !(entry.functionPath ?? "").toLowerCase().includes(pathNeedle)) {
            return false;
        }

        // The message search also matches structured field values, so filtering
        // on e.g. an `orderId` a handler logged just works.
        return needle === "" || entry.message.toLowerCase().includes(needle) || formatLogFields(entry.fields).toLowerCase().includes(needle);
    });
};
/** Em-dash stand-in for entries without a `functionPath`, so they still group. */
const NO_PATH_KEY = "—";

/**
 * Pure aggregation over the (already-filtered) entries: counts per level (in
 * severity order, omitting levels with no hits) and per function path (sorted
 * by count desc, then key asc). This is the "query your logs" rollup without a
 * SQL engine. Module-scope so it is unit-testable.
 */
const summarizeLogs = (entries: ReadonlyArray<LogEntry>): LogSummary => {
    const levelCounts = new Map<LogLevel, number>();
    const pathCounts = new Map<string, number>();

    for (const entry of entries) {
        levelCounts.set(entry.level, (levelCounts.get(entry.level) ?? 0) + 1);

        const pathKey = entry.functionPath ?? NO_PATH_KEY;

        pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
    }

    // react-doctor-disable-next-line react-doctor/js-combine-iterations -- two passes over LOG_LEVEL_ORDER, a five-element constant
    const byLevel: SummaryBucket[] = LOG_LEVEL_ORDER.filter((level) => levelCounts.has(level)).map((level) => {
        return { count: levelCounts.get(level) ?? 0, key: level };
    });

    const byPath: SummaryBucket[] = [...pathCounts.entries()]
        .map(([key, count]) => {
            return { count, key };
        })
        .toSorted((a, b) => (b.count === a.count ? a.key.localeCompare(b.key) : b.count - a.count));

    return { byLevel, byPath, total: entries.length };
};

/**
 * The shard's log feed, newest first, over the gated `__lunora_admin__:*` RPC
 * layer (gated by the server's `LUNORA_ADMIN_TOKEN`). Two views.
 *
 * The Requests view (`getRequestLog`) is the durable, structured per-request log
 * `@lunora/do` writes once per `/rpc` dispatch (PLAN3 §1.1): function path,
 * shard, acting user/identity, redacted args, outcome, duration, and tables
 * read/written. It survives hibernation/restart (bounded retention) and is
 * filtered/correlated SERVER-side on function-path prefix, userId, shard,
 * outcome, and a touched table.
 *
 * The Errors view (`getLogs`) is the legacy in-memory RPC-error buffer, which
 * only captures dispatch failures (path + message) and resets on hibernation —
 * kept for the "what's failing on this instance right now" view, filtered
 * client-side.
 *
 * For the raw, un-attributed request firehose (which Lunora deliberately does
 * NOT re-stream), a deep-link to Cloudflare Workers Observability is provided.
 */
export const LogsPanel = ({ initialShardKey }: LogsPanelProps): ReactElement => {
    const t = useT();

    const [view, setView] = useState<LogsView>("requests");
    const navigate = useNavigate();
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    const [search, setSearch] = useState<string>("");
    // Errors-view client-side filters: a level allow-set (empty = all levels), a
    // function-path substring, and a relative time window. AND-composed.
    const [levelFilter, setLevelFilter] = useState<ReadonlySet<LogLevel>>(() => new Set());
    const [pathFilter, setPathFilter] = useState<string>("");
    const [timeRange, setTimeRange] = useState<TimeRange>("all");
    // Toggle between the entry list and the grouped Summary rollup.
    const [showSummary, setShowSummary] = useState<boolean>(false);

    // Server-side correlation filters for the Requests view.
    const [pathPrefix, setPathPrefix] = useState<string>("");
    const [userIdFilter, setUserIdFilter] = useState<string>("");
    const [tableFilter, setTableFilter] = useState<string>("");
    const [outcomeFilter, setOutcomeFilter] = useState<string>("all");

    // Typed as a plain record too, so it satisfies the `useAdminQuery` args
    // surface (`Record<string, unknown>`) without a per-call-site cast. Folding it
    // into the query args means changing a correlation filter re-fetches the
    // durable Requests log server-side (rather than filtering client-side).
    const requestQuery = buildRequestQuery({ functionPathPrefix: pathPrefix, outcome: outcomeFilter, tableTouched: tableFilter, userId: userIdFilter });

    // One-shot read + always-on live subscription per view, gated to the active
    // one so only the shown feed is fetched/subscribed. Each server push replaces
    // that view's buffer so new entries appear without a manual refresh; the
    // Requests channel carries the same correlation filters as the one-shot read.
    const requestsQuery = useAdminQuery<{ entries?: unknown }>(ADMIN_FUNCTIONS.getRequestLog, requestQuery, {
        enabled: view === "requests",
        live: true,
        shardKey: queryShardKey,
    });

    const errorsQuery = useAdminQuery<{ entries?: unknown }>(
        ADMIN_FUNCTIONS.getLogs,
        {},
        {
            enabled: view === "errors",
            live: true,
            shardKey: queryShardKey,
        },
    );

    const activeQuery = view === "requests" ? requestsQuery : errorsQuery;
    const { error, errorSource, isLoading: activeLoading, liveError } = activeQuery;

    // Hand a log line's trace to the Traces panel and navigate there — the same
    // one-shot handoff the Metrics panel's exemplar link uses, carrying the shard
    // so Traces reads the ring the line came from rather than the root's.
    const openTrace = (traceId: string): void => {
        writePendingTraceFilter({ shardKey: queryShardKey, traceId });
        fireAndForget(navigate({ to: "/traces" }));
    };

    // Coerce each view's resolved payload into its entries array (a one-shot read
    // or live push without an `entries` array yields `[]`); an unloaded gated
    // query's `undefined` data also yields `[]`.
    const entries = entriesOf<LogEntry>(errorsQuery.data);
    const requests = entriesOf<RequestLogEntry>(requestsQuery.data);

    // Record the browsed shard into recent-shards history once the active view's
    // read resolves.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- recording the browsed shard is derived from the resolved read (a value, not a discrete event); writing it when the data lands is the correct pattern.
        if (activeQuery.data !== undefined) {
            recordShard(queryShardKey);
        }
    }, [activeQuery.data, queryShardKey]);

    // AND-composed client-side filter for the Errors view (level allow-set,
    // function-path substring, message substring, relative time window), derived
    // from the already-fetched entries via the pure `filterLogs` helper. `now` is
    // sampled per recompute so the relative time window tracks wall-clock.
    const filtered = filterLogs(entries, { levels: levelFilter, now: Date.now(), path: pathFilter, range: timeRange, search });

    // Grouped rollup over the filtered entries — the "query your logs" view.
    const summary = summarizeLogs(filtered);

    const activeCount = view === "requests" ? requests.length : filtered.length;

    // The grouped Summary replaces the row list (Errors view only). When it is
    // up the virtualized table is suppressed so only one readout is mounted.
    const summaryVisible = view === "errors" && showSummary;

    // The body shows exactly one readout. Computing the discriminant once (rather
    // than gating four JSX blocks on overlapping booleans) keeps the cases provably
    // exclusive — in particular the list can't render an error's empty buffer.
    const readout = useMemo<"empty" | "error" | "list" | "summary">(() => {
        if (error !== null) {
            return "error";
        }

        if (activeCount === 0) {
            // A count of 0 while the active view's first read is still in flight
            // means the buffer hasn't loaded yet — not that the server returned an
            // empty page. Don't flash the empty state; fall through to the (empty)
            // list/summary container until data lands.
            if (activeLoading) {
                return summaryVisible ? "summary" : "list";
            }

            return "empty";
        }

        return summaryVisible ? "summary" : "list";
    }, [activeCount, activeLoading, error, summaryVisible]);

    // Row virtualization over the active list: only the rows intersecting the
    // 400px viewport (+ overscan) are mounted, so a full buffer never renders
    // hundreds of <div>s. See the jsdom note on `flooredRectObserver`.
    const scrollRef = useRef<HTMLDivElement>(null);

    // react-doctor-disable-next-line react-hooks-js/incompatible-library -- TanStack Virtual returns functions the compiler refuses to memoize; the alternative is not using the library
    const virtualizer = useVirtualizer({
        count: activeCount,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 800 },
        observeElementRect: (instance, callback) => flooredRectObserver(instance, callback, SCROLL_HEIGHT),
        overscan: 8,
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const gridStyle = { height: totalSize, position: "relative", width: "100%" } as CSSProperties;

    const onSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    };

    // Toggle one level in/out of the allow-set without mutating the prior set.
    const toggleLevel = (level: LogLevel): void => {
        setLevelFilter((previous) => {
            const next = new Set(previous);

            if (next.has(level)) {
                next.delete(level);
            } else {
                next.add(level);
            }

            return next;
        });
    };

    const onLogPathChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setPathFilter(event.target.value);
    };

    const onTimeRangeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setTimeRange(event.target.value as TimeRange);
    };

    const toggleSummary = (): void => {
        setShowSummary((previous) => !previous);
    };

    const onPathChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setPathPrefix(event.target.value);
    };

    const onUserChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setUserIdFilter(event.target.value);
    };

    const onTableChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setTableFilter(event.target.value);
    };

    const onOutcomeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setOutcomeFilter(event.target.value);
    };

    // Switching views resets the Summary toggle so a view change always lands on
    // the row list (the summary is an Errors-only opt-in, not a sticky mode).
    const showRequests = (): void => {
        setView("requests");
        setShowSummary(false);
    };

    const showErrors = (): void => {
        setView("errors");
        setShowSummary(false);
    };

    const showArchive = (): void => {
        setView("archive");
        setShowSummary(false);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-logs">
            <LogsViewBar
                liveError={liveError}
                onShardKeyChange={setShardKey}
                onShowArchive={showArchive}
                onShowErrors={showErrors}
                onShowRequests={showRequests}
                shardKey={shardKey}
                view={view}
            />

            {view === "errors" && (
                <LogsErrorFilters
                    levelFilter={levelFilter}
                    onLogPathChange={onLogPathChange}
                    onSearchChange={onSearchChange}
                    onTimeRangeChange={onTimeRangeChange}
                    onToggleLevel={toggleLevel}
                    onToggleSummary={toggleSummary}
                    pathFilter={pathFilter}
                    search={search}
                    showSummary={showSummary}
                    timeRange={timeRange}
                />
            )}

            {view === "requests" && (
                <LogsRequestFilters
                    onOutcomeChange={onOutcomeChange}
                    onPathChange={onPathChange}
                    onTableChange={onTableChange}
                    onUserChange={onUserChange}
                    outcomeFilter={outcomeFilter}
                    pathPrefix={pathPrefix}
                    tableFilter={tableFilter}
                    userIdFilter={userIdFilter}
                />
            )}

            {/* Archive is a wholly separate view (its own HTTP feed), mutually exclusive
                with the readout state machine — so it's gated once, not negated on every
                `readout` branch. */}
            {view === "archive" ? (
                <ArchiveFeed shardKey={queryShardKey} />
            ) : (
                <>
                    {readout === "error" && <ErrorAlert error={errorSource} testId="lg-error" />}

                    {readout === "empty" && (
                        <EmptyState
                            description={t("Function and request logs for this shard show up here as your app handles traffic.")}
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
                                    <path d="M4 5h16M4 12h16M4 19h10" />
                                </svg>
                            }
                            testId="lg-empty"
                            title={t("No logs.")}
                        />
                    )}

                    {readout === "summary" && <LogsSummary summary={summary} />}

                    {readout === "list" && (
                        <div className="rounded-xl border border-border shadow-xs" data-testid="lg-scroll" ref={scrollRef} style={SCROLL_STYLE}>
                            <div aria-label={t("Recent logs")} data-testid="lg-table" role="grid" style={gridStyle}>
                                {virtualRows.map((virtualRow) =>
                                    view === "requests" ? (
                                        <RequestRow
                                            entry={requests[virtualRow.index] as RequestLogEntry}
                                            index={virtualRow.index}
                                            key={virtualRow.key}
                                            measureRef={virtualizer.measureElement}
                                            start={virtualRow.start}
                                        />
                                    ) : (
                                        <LogRow
                                            entry={filtered[virtualRow.index] as LogEntry}
                                            index={virtualRow.index}
                                            key={virtualRow.key}
                                            measureRef={virtualizer.measureElement}
                                            onOpenTrace={openTrace}
                                            start={virtualRow.start}
                                        />
                                    ),
                                )}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export { filterLogs, summarizeLogs };
export type { LogFilterCriteria, LogsPanelProps, TimeRange };

export { type LogsView } from "./logs-view-bar";
