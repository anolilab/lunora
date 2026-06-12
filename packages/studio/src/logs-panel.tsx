import { useCirrus } from "@cirrus/react";
import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { LogEntry, LogLevel, LogsResult, RequestLogEntry, RequestLogQuery, RequestLogResult, RequestOutcome } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage } from "./internal";
import { CLOUDFLARE_OBSERVABILITY_URL } from "./lib/cf-links";
import { cn } from "./lib/utils";
import { LiveError } from "./live-status";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";
import useLiveAdmin from "./use-live-admin";
import useLiveShardSeed from "./use-live-shard-seed";

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

/**
 * Viewport-rect observer that floors the measured height to {@link SCROLL_HEIGHT}
 * whenever layout reports a zero-height box. In a real browser the scroll
 * container always has its CSS height, so this is a no-op there; under jsdom
 * (which reports every `getBoundingClientRect()` as a 0x0 box) it gives the
 * virtualizer a real viewport to compute a visible range from, so a bounded,
 * deterministic set of rows mounts in tests instead of zero.
 */
const observeViewportRect = (instance: Virtualizer<HTMLDivElement, Element>, callback: (rect: Rect) => void): (() => void) | undefined =>
    observeElementRect(instance, (rect) => {
        callback(rect.height > 0 ? rect : { height: SCROLL_HEIGHT, width: rect.width });
    });

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
    const style = useMemo<CSSProperties>(() => {
        return { ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` };
    }, [start]);

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
    const style = useMemo<CSSProperties>(() => {
        return { ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` };
    }, [start]);

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

const GET_LOGS = adminRef(ADMIN_FUNCTIONS.getLogs);
const GET_REQUEST_LOG = adminRef(ADMIN_FUNCTIONS.getRequestLog);

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
 * Pure, AND-composed filter over the loaded log entries. Cirrus's `getLogs` is
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

        return needle === "" || entry.message.toLowerCase().includes(needle);
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
    const onClick = useCallback((): void => {
        onToggle(level);
    }, [level, onToggle]);

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
 * The shard's log feed, newest first, over the gated `__cirrus_admin__:*` RPC
 * layer (gated by the server's `CIRRUS_ADMIN_TOKEN`). Two views.
 *
 * The Requests view (`getRequestLog`) is the durable, structured per-request log
 * `@cirrus/do` writes once per `/rpc` dispatch (PLAN3 §1.1): function path,
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
 * For the raw, un-attributed request firehose (which Cirrus deliberately does
 * NOT re-stream), a deep-link to Cloudflare Workers Observability is provided.
 */
export const LogsPanel = ({ initialShardKey }: LogsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [view, setView] = useState<LogsView>("requests");
    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [requests, setRequests] = useState<RequestLogEntry[]>([]);
    const [error, setError] = useState<null | string>(null);
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
    // Always-on live channel; this only holds a rejection message (e.g. missing
    // admin token) so the panel can say why it stopped updating.
    const [liveError, setLiveError] = useState<string | undefined>(undefined);

    // Typed as a plain record too, so it satisfies the `query`/`useLiveAdmin`
    // args surface (`Record<string, unknown>`) without a per-call-site cast.
    const requestQuery = useMemo<Record<string, unknown> & RequestLogQuery>(
        () => buildRequestQuery({ functionPathPrefix: pathPrefix, outcome: outcomeFilter, tableTouched: tableFilter, userId: userIdFilter }),
        [pathPrefix, outcomeFilter, tableFilter, userIdFilter],
    );

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                if (view === "requests") {
                    const result = (await client.query(GET_REQUEST_LOG, requestQuery, callOptions(shard))) as RequestLogResult;

                    recordShard(shard);
                    setRequests(result.entries);
                } else {
                    const result = (await client.query(GET_LOGS, {}, callOptions(shard))) as LogsResult;

                    recordShard(shard);
                    setEntries(result.entries);
                }
            } catch (error_) {
                setEntries([]);
                setRequests([]);
                setError(errorMessage(error_));

                // Rethrow so the shard-seed hook doesn't commit a shard that failed.
                throw error_;
            }
        },
        [client, view, requestQuery],
    );

    // Debounced shard seed + commit-on-success; also re-seeds when the view or the
    // server-side request filters change (so the Requests view re-queries the
    // durable log rather than filtering client-side). Replaces the old Refresh button.
    const committedShard = useLiveShardSeed(shardKey, refresh, [view, requestQuery]);

    // Live channel: always on for the active view; each server push replaces that
    // view's buffer so new entries appear without a manual refresh. The Requests
    // channel carries the same correlation filters as the one-shot read.
    useLiveAdmin(
        ADMIN_FUNCTIONS.getRequestLog,
        requestQuery,
        committedShard ?? "",
        (result) => {
            setError(null);
            setLiveError(undefined);
            setRequests((result as RequestLogResult).entries);
        },
        view === "requests" && committedShard !== undefined,
        setLiveError,
    );

    useLiveAdmin(
        ADMIN_FUNCTIONS.getLogs,
        {},
        committedShard ?? "",
        (result) => {
            setError(null);
            setLiveError(undefined);
            setEntries((result as LogsResult).entries);
        },
        view === "errors" && committedShard !== undefined,
        setLiveError,
    );

    // AND-composed client-side filter for the Errors view (level allow-set,
    // function-path substring, message substring, relative time window), derived
    // from the already-fetched entries via the pure `filterLogs` helper. `now` is
    // sampled per recompute so the relative time window tracks wall-clock.
    const filtered = useMemo<LogEntry[]>(
        () => filterLogs(entries, { levels: levelFilter, now: Date.now(), path: pathFilter, range: timeRange, search }),
        [entries, search, levelFilter, pathFilter, timeRange],
    );

    // Grouped rollup over the filtered entries — the "query your logs" view.
    const summary = useMemo<LogSummary>(() => summarizeLogs(filtered), [filtered]);

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
            return "empty";
        }

        return summaryVisible ? "summary" : "list";
    }, [activeCount, error, summaryVisible]);

    // Row virtualization over the active list: only the rows intersecting the
    // 400px viewport (+ overscan) are mounted, so a full buffer never renders
    // hundreds of <div>s. See the jsdom note on `observeViewportRect`.
    const scrollRef = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: activeCount,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 800 },
        observeElementRect: observeViewportRect,
        overscan: 8,
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const gridStyle = useMemo<CSSProperties>(() => {
        return { height: totalSize, position: "relative", width: "100%" };
    }, [totalSize]);

    const onSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    }, []);

    // Toggle one level in/out of the allow-set without mutating the prior set.
    const toggleLevel = useCallback((level: LogLevel): void => {
        setLevelFilter((previous) => {
            const next = new Set(previous);

            if (next.has(level)) {
                next.delete(level);
            } else {
                next.add(level);
            }

            return next;
        });
    }, []);

    const onLogPathChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setPathFilter(event.target.value);
    }, []);

    const onTimeRangeChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setTimeRange(event.target.value as TimeRange);
    }, []);

    const toggleSummary = useCallback((): void => {
        setShowSummary((previous) => !previous);
    }, []);

    const onPathChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setPathPrefix(event.target.value);
    }, []);

    const onUserChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setUserIdFilter(event.target.value);
    }, []);

    const onTableChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setTableFilter(event.target.value);
    }, []);

    const onOutcomeChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setOutcomeFilter(event.target.value);
    }, []);

    // Switching views resets the Summary toggle so a view change always lands on
    // the row list (the summary is an Errors-only opt-in, not a sticky mode).
    const showRequests = useCallback((): void => {
        setView("requests");
        setShowSummary(false);
    }, []);

    const showErrors = useCallback((): void => {
        setView("errors");
        setShowSummary(false);
    }, []);

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-logs">
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-md border border-border" role="tablist">
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

            {readout === "error" && (
                <p className="text-sm text-destructive" data-testid="lg-error" role="alert">
                    {error}
                </p>
            )}

            {readout === "empty" && (
                <p className="text-sm text-muted-foreground" data-testid="lg-empty">
                    {t("No logs.")}
                </p>
            )}

            {readout === "summary" && (
                <div className="flex flex-col gap-4 rounded-md border border-border p-3" data-testid="logs-summary">
                    <p className="text-xs text-muted-foreground" data-testid="logs-summary-total">
                        {t("{count} entries", { count: summary.total })}
                    </p>
                    <div>
                        <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("By level")}</h4>
                        <div className="rounded-md border border-border" data-testid="logs-summary-levels" role="grid">
                            {summary.byLevel.map((bucket) => (
                                <SummaryBucketRow bucket={bucket} key={bucket.key} />
                            ))}
                        </div>
                    </div>
                    <div>
                        <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("By function")}</h4>
                        <div className="rounded-md border border-border" data-testid="logs-summary-paths" role="grid">
                            {summary.byPath.map((bucket) => (
                                <SummaryBucketRow bucket={bucket} key={bucket.key} />
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {readout === "list" && (
                <div className="rounded-md border border-border" data-testid="lg-scroll" ref={scrollRef} style={SCROLL_STYLE}>
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
