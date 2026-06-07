import { useCirrus } from "@cirrus/react";
import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LogEntry, LogLevel, LogsResult, RequestLogEntry, RequestLogQuery, RequestLogResult, RequestOutcome } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import useLiveAdmin from "./use-live-admin.js";
import { useLiveToggle } from "./use-live-toggle.js";

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
 * Cloudflare Workers Observability — the raw, un-attributed request firehose.
 * Cirrus's request log is the cirrus-attributed readout (function/shard/user/
 * tables); the raw transport stays with Workers Logs / Logpush
 * (`CLOUDFLARE-REUSE-AUDIT.md` #5), so we deep-link out rather than re-stream it.
 */
const CLOUDFLARE_OBSERVABILITY_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability";

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
    // The shard a successful one-shot last targeted. The live channel keys on
    // this committed value (not the live `shardKey` input) so editing the shard
    // box without refreshing doesn't resubscribe to a half-typed shard on every
    // keystroke — mirroring DataBrowser's `loaded.shard`.
    const [committedShard, setCommittedShard] = useState<null | string>(null);
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [requests, setRequests] = useState<RequestLogEntry[]>([]);
    const [error, setError] = useState<null | string>(null);
    const [search, setSearch] = useState<string>("");
    const [levelFilter, setLevelFilter] = useState<string>("all");

    // Server-side correlation filters for the Requests view.
    const [pathPrefix, setPathPrefix] = useState<string>("");
    const [userIdFilter, setUserIdFilter] = useState<string>("");
    const [tableFilter, setTableFilter] = useState<string>("");
    const [outcomeFilter, setOutcomeFilter] = useState<string>("all");
    const { live, liveError, setLiveError, toggle } = useLiveToggle();

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
                    setCommittedShard(shard);
                    setRequests(result.entries);
                } else {
                    const result = (await client.query(GET_LOGS, {}, callOptions(shard))) as LogsResult;

                    recordShard(shard);
                    setCommittedShard(shard);
                    setEntries(result.entries);
                }
            } catch (error_) {
                setEntries([]);
                setRequests([]);
                setError(errorMessage(error_));
            }
        },
        [client, view, requestQuery],
    );

    // Reload whenever the view or the server-side request filters change, so the
    // Requests view re-queries the durable log rather than filtering client-side.
    useEffect(() => {
        fireAndForget(refresh(committedShard ?? initialShardKey ?? ""));
        // committedShard is intentionally excluded: refresh sets it, so including
        // it would loop. The shard a reload targets is the last committed one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh, initialShardKey]);

    // Live channel: while toggled on, each server push replaces the active view's
    // buffer so new entries appear without a manual refresh. The Requests channel
    // carries the same correlation filters as the one-shot read.
    useLiveAdmin(
        ADMIN_FUNCTIONS.getRequestLog,
        requestQuery,
        committedShard ?? "",
        (result) => {
            setError(null);
            setLiveError(undefined);
            setRequests((result as RequestLogResult).entries);
        },
        live && view === "requests" && committedShard !== null,
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
        live && view === "errors" && committedShard !== null,
        setLiveError,
    );

    // Distinct levels present in the fetched buffer, in a stable severity order,
    // so the dropdown only offers levels that can actually match something.
    const levels = useMemo<LogLevel[]>(() => {
        const present = new Set(entries.map((entry) => entry.level));

        return (["debug", "info", "warn", "error"] as const).filter((level) => present.has(level));
    }, [entries]);

    // Client-side search (message substring, case-insensitive) AND level filter
    // for the Errors view, derived from the already-fetched entries.
    const filtered = useMemo<LogEntry[]>(() => {
        const needle = search.trim().toLowerCase();

        return entries.filter((entry) => {
            if (levelFilter !== "all" && entry.level !== levelFilter) {
                return false;
            }

            return needle === "" || entry.message.toLowerCase().includes(needle);
        });
    }, [entries, search, levelFilter]);

    const activeCount = view === "requests" ? requests.length : filtered.length;

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

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const onSearchChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setSearch(event.target.value);
    }, []);

    const onLevelChange = useCallback((event: ChangeEvent<HTMLSelectElement>): void => {
        setLevelFilter(event.target.value);
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

    const showRequests = useCallback((): void => {
        setView("requests");
    }, []);

    const showErrors = useCallback((): void => {
        setView("errors");
    }, []);

    return (
        <div className="flex flex-col gap-3" data-testid="cirrus-logs">
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-md border border-border" role="tablist">
                    <button
                        aria-selected={view === "requests"}
                        className={`px-3 py-1 text-sm ${view === "requests" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                        data-testid="lg-view-requests"
                        onClick={showRequests}
                        role="tab"
                        type="button"
                    >
                        {t("Requests")}
                    </button>
                    <button
                        aria-selected={view === "errors"}
                        className={`px-3 py-1 text-sm ${view === "errors" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                        data-testid="lg-view-errors"
                        onClick={showErrors}
                        role="tab"
                        type="button"
                    >
                        {t("Errors")}
                    </button>
                </div>
                <ShardInput onChange={setShardKey} testId="lg-shard-input" value={shardKey} />
                <Button data-testid="lg-refresh" onClick={refreshCurrent} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="lg" />
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
                    <select
                        aria-label={t("Level filter")}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        data-testid="lg-level-filter"
                        onChange={onLevelChange}
                        value={levelFilter}
                    >
                        <option value="all">{t("all")}</option>
                        {levels.map((level) => (
                            <option key={level} value={level}>
                                {level}
                            </option>
                        ))}
                    </select>
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

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="lg-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && activeCount === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="lg-empty">
                    {t("No logs.")}
                </p>
            )}

            {activeCount > 0 && (
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

export type { LogsPanelProps };
