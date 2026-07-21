import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

// Bundler-inlined, zero-dep `key=value` field renderer shared with the runtime
// sinks and the dev-terminal formatter (see CLAUDE.md `shared/` rules).
import { formatLogFields } from "../../../../../shared/log-fields";
import { ErrorAlert } from "../../components/error-alert";
import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { LogEntry, LogLevel, RequestLogEntry, RequestLogQuery, RequestOutcome } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_OBSERVABILITY_URL } from "../../lib/cf-links";
import { recordShard } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import flooredRectObserver from "../../lib/virtual-rect";

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

type BadgeVariant = "default" | "destructive" | "outline" | "secondary";

/** Maps a log level to a shadcn Badge variant for Supabase-style severity chips. */
const LEVEL_VARIANT: Record<LogLevel, BadgeVariant> = {
    debug: "secondary",
    error: "destructive",
    info: "outline",
    warn: "secondary",
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
    /** Pixel offset of this row from the top of the virtualized list. */
    readonly start: number;
}

/**
 * One absolutely-positioned virtualized log row. Extracted into its own
 * component so its per-row `style` (which carries the dynamic `translateY`
 * offset) is a `useMemo`-stable reference — keeping the hot map body free of
 * fresh inline objects.
 */
const LogRow = ({ entry, index, measureRef, start }: LogRowProps): ReactElement => {
    const style = { ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` };
    // Rendered once; `""` (no fields, or an empty bag from a worker predating
    // field normalization) skips the chip entirely rather than showing a blank span.
    const fields = formatLogFields(entry.fields);

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
type LogsView = "errors" | "requests";

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

/** The four log severities, in ascending order, for the multi-select control. */
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

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

/** One `{ key, count }` bucket of a grouped summary, used for level and path rollups. */
interface SummaryBucket {
    readonly count: number;
    readonly key: string;
}

/** Grouped counts over a set of entries: by level (severity order) and by function path. */
interface LogSummary {
    readonly byLevel: SummaryBucket[];
    readonly byPath: SummaryBucket[];
    readonly total: number;
}

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

    const byLevel: SummaryBucket[] = LOG_LEVELS.filter((level) => levelCounts.has(level)).map((level) => {
        return { count: levelCounts.get(level) ?? 0, key: level };
    });

    const byPath: SummaryBucket[] = [...pathCounts.entries()]
        .map(([key, count]) => {
            return { count, key };
        })
        .toSorted((a, b) => (b.count === a.count ? a.key.localeCompare(b.key) : b.count - a.count));

    return { byLevel, byPath, total: entries.length };
};

interface LevelToggleProps {
    readonly level: LogLevel;
    /** Lifts the per-item click out of the map so the row carries no inline closure. */
    readonly onToggle: (level: LogLevel) => void;
    readonly selected: boolean;
}

/**
 * One level chip in the multi-select. Extracted so each chip owns a stable,
 * `useCallback`-bound click handler (no fresh closure per render of the map).
 */
const LevelToggle = ({ level, onToggle, selected }: LevelToggleProps): ReactElement => {
    const onClick = (): void => {
        onToggle(level);
    };

    return (
        <button
            aria-pressed={selected}
            className={cn("rounded-md border px-2 py-1 text-xs", selected ? "border-border bg-muted font-medium" : "border-input text-muted-foreground")}
            data-testid={`logs-level-${level}`}
            onClick={onClick}
            type="button"
        >
            {level}
        </button>
    );
};

interface SummaryBucketRowProps {
    readonly bucket: SummaryBucket;
}

/** One `key → count` row in a summary group. */
const SummaryBucketRow = ({ bucket }: SummaryBucketRowProps): ReactElement => (
    <div className="flex items-center justify-between gap-4 px-3 py-1 font-mono text-xs" data-testid="logs-summary-row" role="row">
        <span className="truncate text-muted-foreground" role="gridcell">
            {bucket.key}
        </span>
        <span className="shrink-0 tabular-nums" role="gridcell">
            {bucket.count}
        </span>
    </div>
);

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
    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
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

    // The shard the reads target, debounced so typing a key settles before
    // refetching (and re-subscribing) rather than firing per keystroke.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

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
        shardKey: debouncedShard,
    });

    const errorsQuery = useAdminQuery<{ entries?: unknown }>(
        ADMIN_FUNCTIONS.getLogs,
        {},
        {
            enabled: view === "errors",
            live: true,
            shardKey: debouncedShard,
        },
    );

    const activeQuery = view === "requests" ? requestsQuery : errorsQuery;
    const { error, errorSource, isLoading: activeLoading, liveError } = activeQuery;

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
            recordShard(debouncedShard);
        }
    }, [activeQuery.data, debouncedShard]);

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

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-logs">
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-lg border border-border" role="tablist">
                    <button
                        aria-selected={view === "requests"}
                        className={cn("px-3 py-1 text-sm", view === "requests" ? "bg-muted font-medium" : "text-muted-foreground")}
                        data-testid="lg-view-requests"
                        onClick={showRequests}
                        role="tab"
                        type="button"
                    >
                        {t("Requests")}
                    </button>
                    <button
                        aria-selected={view === "errors"}
                        className={cn("px-3 py-1 text-sm", view === "errors" ? "bg-muted font-medium" : "text-muted-foreground")}
                        data-testid="lg-view-errors"
                        onClick={showErrors}
                        role="tab"
                        type="button"
                    >
                        {t("Errors")}
                    </button>
                </div>
                <ShardInput onChange={setShardKey} testId="lg-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="lg" />
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="lg-cf-link"
                    href={CLOUDFLARE_OBSERVABILITY_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            {view === "errors" && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        aria-label={t("Search messages")}
                        className="h-8 w-48"
                        data-testid="lg-search"
                        onChange={onSearchChange}
                        placeholder={t("search message")}
                        value={search}
                    />
                    <Input
                        aria-label={t("Function path")}
                        className="h-8 w-40"
                        data-testid="logs-path-filter"
                        onChange={onLogPathChange}
                        placeholder={t("filter path")}
                        value={pathFilter}
                    />
                    <div aria-label={t("Level filter")} className="inline-flex items-center gap-1" data-testid="logs-level-filter" role="group">
                        {LOG_LEVELS.map((level) => (
                            <LevelToggle key={level} level={level} onToggle={toggleLevel} selected={levelFilter.has(level)} />
                        ))}
                    </div>
                    <select
                        aria-label={t("Time range")}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        data-testid="logs-time-range"
                        onChange={onTimeRangeChange}
                        value={timeRange}
                    >
                        <option value="all">{t("All time")}</option>
                        <option value="5m">{t("Last 5m")}</option>
                        <option value="15m">{t("Last 15m")}</option>
                        <option value="1h">{t("Last hour")}</option>
                    </select>
                    <button
                        aria-pressed={showSummary}
                        className={cn(
                            "h-8 rounded-md border px-3 text-sm",
                            showSummary ? "border-border bg-muted font-medium" : "border-input text-muted-foreground",
                        )}
                        data-testid="logs-summary-toggle"
                        onClick={toggleSummary}
                        type="button"
                    >
                        {showSummary ? t("List") : t("Summary")}
                    </button>
                </div>
            )}

            {view === "requests" && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        aria-label={t("Function path")}
                        className="h-8 w-44"
                        data-testid="lg-req-path"
                        onChange={onPathChange}
                        placeholder={t("file:function")}
                        value={pathPrefix}
                    />
                    <Input
                        aria-label={t("User id")}
                        className="h-8 w-32"
                        data-testid="lg-req-user"
                        onChange={onUserChange}
                        placeholder={t("userId")}
                        value={userIdFilter}
                    />
                    <Input
                        aria-label={t("Table touched")}
                        className="h-8 w-32"
                        data-testid="lg-req-table"
                        onChange={onTableChange}
                        placeholder={t("table")}
                        value={tableFilter}
                    />
                    <select
                        aria-label={t("Outcome filter")}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        data-testid="lg-req-outcome"
                        onChange={onOutcomeChange}
                        value={outcomeFilter}
                    >
                        <option value="all">{t("all")}</option>
                        <option value="ok">{t("ok")}</option>
                        <option value="error">{t("error")}</option>
                    </select>
                </div>
            )}

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

            {readout === "summary" && (
                <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-xs" data-testid="logs-summary">
                    <p className="text-xs text-muted-foreground" data-testid="logs-summary-total">
                        {t("{count} entries", { count: summary.total })}
                    </p>
                    <div>
                        <h4 className="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("By level")}</h4>
                        <div className="overflow-hidden rounded-lg border border-border" data-testid="logs-summary-levels" role="grid">
                            {summary.byLevel.map((bucket) => (
                                <SummaryBucketRow bucket={bucket} key={bucket.key} />
                            ))}
                        </div>
                    </div>
                    <div>
                        <h4 className="mb-1 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("By function")}</h4>
                        <div className="overflow-hidden rounded-lg border border-border" data-testid="logs-summary-paths" role="grid">
                            {summary.byPath.map((bucket) => (
                                <SummaryBucketRow bucket={bucket} key={bucket.key} />
                            ))}
                        </div>
                    </div>
                </div>
            )}

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
                                    start={virtualRow.start}
                                />
                            ),
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export { filterLogs, summarizeLogs };
export type { LogFilterCriteria, LogsPanelProps, LogSummary, SummaryBucket, TimeRange };
