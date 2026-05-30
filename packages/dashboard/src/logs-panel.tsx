import { useCirrus } from "@cirrus/react";
import { observeElementRect, type Rect, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { type ChangeEvent, type CSSProperties, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ADMIN_FUNCTIONS, type LogEntry, type LogLevel, type LogsResult } from "./admin.js";
import { adminRef, callOptions, errorMessage } from "./internal.js";

/** Fixed height of the scroll viewport; bounds how many rows can be live at once. */
const SCROLL_HEIGHT = 400;

/** Estimated height of a single virtualized log row. */
const ROW_HEIGHT = 36;

/** Static style for the scrollable viewport (bounded height + overflow). */
const SCROLL_STYLE: CSSProperties = { height: SCROLL_HEIGHT, overflow: "auto" };

/** Static base style for an absolutely-positioned virtualized row. */
const ROW_BASE_STYLE: CSSProperties = {
    display: "flex",
    gap: 12,
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
const observeViewportRect = (
    instance: Virtualizer<HTMLDivElement, Element>,
    callback: (rect: Rect) => void,
): (() => void) | undefined =>
    observeElementRect(instance, (rect) => {
        callback(rect.height > 0 ? rect : { height: SCROLL_HEIGHT, width: rect.width });
    });

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
function LogRow({ entry, index, measureRef, start }: LogRowProps): ReactElement {
    const style = useMemo<CSSProperties>(() => ({ ...ROW_BASE_STYLE, transform: `translateY(${String(start)}px)` }), [start]);

    return (
        <div data-index={index} data-testid="lg-row" ref={measureRef} role="row" style={style}>
            <span role="gridcell">{new Date(entry.timestamp).toLocaleString()}</span>
            <span role="gridcell">{entry.level}</span>
            <span role="gridcell">{entry.functionPath ?? "—"}</span>
            <span role="gridcell">{entry.message}</span>
        </div>
    );
}

export interface LogsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_LOGS = adminRef(ADMIN_FUNCTIONS.getLogs);

/**
 * Recent RPC errors for a single shard instance, newest first. Reads via the
 * `__cirrus_admin__:getLogs` RPC over the {@link useCirrus} client; gated by the
 * server's `CIRRUS_ADMIN_TOKEN`.
 *
 * This is intentionally NOT a general application log: `ShardDO` only captures
 * RPC dispatch failures (path + error message), not user `console.*` output,
 * and the buffer is in-memory so it resets when the DO hibernates or restarts.
 * Treat it as a "what's been failing on this instance lately" feed.
 */
export function LogsPanel({ initialShardKey }: LogsPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [error, setError] = useState<null | string>(null);
    const [search, setSearch] = useState<string>("");
    const [levelFilter, setLevelFilter] = useState<string>("all");

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const result = (await client.query(GET_LOGS, {}, callOptions(shard))) as LogsResult;

                setEntries(result.entries);
            } catch (error_) {
                setEntries([]);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    // Distinct levels present in the fetched buffer, in a stable severity order,
    // so the dropdown only offers levels that can actually match something.
    const levels = useMemo<LogLevel[]>(() => {
        const present = new Set(entries.map((entry) => entry.level));

        return (["debug", "info", "warn", "error"] as const).filter((level) => present.has(level));
    }, [entries]);

    // Client-side search (message substring, case-insensitive) AND level filter,
    // derived from the already-fetched entries — never triggers a refetch.
    const filtered = useMemo<LogEntry[]>(() => {
        const needle = search.trim().toLowerCase();

        return entries.filter((entry) => {
            if (levelFilter !== "all" && entry.level !== levelFilter) {
                return false;
            }

            return needle === "" || entry.message.toLowerCase().includes(needle);
        });
    }, [entries, search, levelFilter]);

    // Row virtualization over the FILTERED list: only the rows intersecting the
    // 400px viewport (+ overscan) are mounted, so a full 500-entry buffer never
    // renders 500 <div>s.
    //
    // jsdom note: jsdom reports every element's `getBoundingClientRect()` as a
    // zero-sized box, which would make the virtualizer believe the viewport has
    // no height and render zero rows. `initialRect` seeds the first paint, and
    // `observeViewportRect` floors every subsequent measurement (e.g. after a
    // filter change re-runs the rect observer) to SCROLL_HEIGHT when layout
    // reports 0 — so the visible range stays deterministic and non-empty in
    // tests. In a real browser the container has its CSS height, so both are
    // no-ops and the live measured rect drives the window.
    const scrollRef = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: filtered.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 800 },
        observeElementRect: observeViewportRect,
        overscan: 8,
    });

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const gridStyle = useMemo<CSSProperties>(() => ({ height: totalSize, position: "relative", width: "100%" }), [totalSize]);

    return (
        <div data-testid="cirrus-logs">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="lg-shard-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="lg-refresh"
                    onClick={() => {
                        void refresh(shardKey);
                    }}
                    type="button"
                >
                    Refresh
                </button>
                <input
                    aria-label="Search messages"
                    data-testid="lg-search"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setSearch(event.target.value);
                    }}
                    placeholder="search message"
                    value={search}
                />
                <select
                    aria-label="Level filter"
                    data-testid="lg-level-filter"
                    onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        setLevelFilter(event.target.value);
                    }}
                    value={levelFilter}
                >
                    <option value="all">all</option>
                    {levels.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
            </div>

            {error !== null && (
                <p data-testid="lg-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && filtered.length === 0 && <p data-testid="lg-empty">No logs.</p>}

            {filtered.length > 0 && (
                <div data-testid="lg-scroll" ref={scrollRef} style={SCROLL_STYLE}>
                    <div aria-label="Recent logs" data-testid="lg-table" role="grid" style={gridStyle}>
                        {virtualRows.map((virtualRow) => (
                            <LogRow
                                entry={filtered[virtualRow.index] as LogEntry}
                                index={virtualRow.index}
                                key={virtualRow.key}
                                measureRef={virtualizer.measureElement}
                                start={virtualRow.start}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
