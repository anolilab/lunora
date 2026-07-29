import { useVirtualizer } from "@tanstack/react-virtual";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import flooredRectObserver from "../../lib/virtual-rect";

/** Estimated height of one sidebar table row, used to size the virtualized list. */
const TABLE_ROW_HEIGHT = 34;
/** Fallback viewport height (px) for the table-list virtualizer when layout reports 0 (jsdom). */
const TABLE_LIST_VIEWPORT = 600;

/** One row in the table sidebar: a table name and its current row count. */
interface TableListItem {
    readonly name: string;
    readonly rowCount: number;
}

interface TableListButtonProps {
    readonly item: TableListItem;
    readonly onSelect: (name: string) => void;
    readonly prefix: string;
    readonly selected: boolean;
    /** Pixel offset from the top of the virtualized list (absolute-positions the row). */
    readonly start: number;
}

/**
 * One sidebar table entry, absolutely positioned at its virtualized `start`.
 * Extracted so each binds its `onClick` through a stable `useCallback` (closing
 * over the table name) and its position `style` through a `useMemo`.
 */
const TableListButton = ({ item, onSelect, prefix, selected, start }: TableListButtonProps): ReactElement => {
    const onClick = (): void => {
        onSelect(item.name);
    };
    const style = { insetInline: 0, position: "absolute", top: 0, transform: `translateY(${String(start)}px)` } as CSSProperties;

    return (
        <li style={style}>
            <button
                aria-pressed={selected}
                className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent",
                    selected ? "bg-accent font-medium text-accent-foreground" : "text-foreground",
                )}
                data-testid={`${prefix}-table-${item.name}`}
                onClick={onClick}
                type="button"
            >
                <span className="truncate">{item.name}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{item.rowCount}</span>
            </button>
        </li>
    );
};

interface TableListSidebarProps {
    /** Optional content rendered above the list (e.g. a shard-key picker). */
    readonly header?: ReactNode;
    /** Optional reload control rendered in the sidebar header. */
    readonly onReload?: () => void;
    readonly onSelect: (name: string) => void;
    /** Scopes `data-testid`s: `{prefix}-table-list`, `{prefix}-table-&lt;name>`, `{prefix}-load-tables`. */
    readonly prefix: string;
    readonly reloadLabel?: string;
    readonly selected: null | string;
    readonly tables: ReadonlyArray<TableListItem>;
}

/**
 * The Supabase-style table sidebar: a full-height left rail listing the tables in
 * the current source, with a filter box at the top and each table a selectable row
 * showing its name and a row-count badge. The active table is highlighted. Shared
 * by the shard and global data browsers so both read identically. An optional
 * `header` slot renders above the list (the shard browser puts its shard-key
 * picker there). Owns the table-filter text locally so the parents stay unchanged.
 * The list is virtualized so a schema with hundreds of tables only mounts the rows
 * in view (+ overscan) instead of one button per table.
 */
const TableListSidebar = ({ header, onReload, onSelect, prefix, reloadLabel, selected, tables }: TableListSidebarProps): ReactElement => {
    const t = useT();
    const [query, setQuery] = useState<string>("");
    const scrollRef = useRef<HTMLUListElement | null>(null);

    const onQueryChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setQuery(event.target.value);
    };

    const filtered = useMemo<ReadonlyArray<TableListItem>>(() => {
        const needle = query.trim().toLowerCase();

        return needle === "" ? tables : tables.filter((item) => item.name.toLowerCase().includes(needle));
    }, [query, tables]);

    // react-doctor-disable-next-line react-hooks-js/incompatible-library -- TanStack Virtual returns functions the compiler refuses to memoize; the alternative is not using the library
    const virtualizer = useVirtualizer({
        count: filtered.length,
        estimateSize: () => TABLE_ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: TABLE_LIST_VIEWPORT, width: 240 },
        observeElementRect: (instance, callback) => flooredRectObserver(instance, callback, TABLE_LIST_VIEWPORT),
        overscan: 12,
    });
    const virtualRows = virtualizer.getVirtualItems();
    const trackStyle = { height: filtered.length * TABLE_ROW_HEIGHT };

    return (
        <aside className="flex h-full w-60 shrink-0 flex-col border-e border-border bg-sidebar" data-testid={`${prefix}-table-list`}>
            {header}
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                <span className="font-mono text-[11px] tracking-wide uppercase text-muted-foreground">{t("Tables")}</span>
                {onReload !== undefined && (
                    <button
                        aria-label={reloadLabel ?? t("Refresh")}
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
                        data-testid={`${prefix}-load-tables`}
                        onClick={onReload}
                        title={reloadLabel ?? t("Refresh")}
                        type="button"
                    >
                        <svg
                            aria-hidden="true"
                            className="size-3.5"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4" />
                        </svg>
                    </button>
                )}
            </div>
            <div className="shrink-0 border-b border-border p-2">
                <input
                    className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                    data-testid={`${prefix}-table-search`}
                    onChange={onQueryChange}
                    placeholder={t("search table…")}
                    type="search"
                    value={query}
                />
            </div>
            <ul className="relative flex-1 overflow-y-auto p-1.5" data-testid={`${prefix}-table-list-rows`} ref={scrollRef}>
                {/* Spacer that gives the scroll container its full virtual height. */}
                <li aria-hidden="true" style={trackStyle} />
                {virtualRows.map((vrow) => {
                    const item = filtered[vrow.index];

                    return item === undefined ? null : (
                        <TableListButton item={item} key={item.name} onSelect={onSelect} prefix={prefix} selected={selected === item.name} start={vrow.start} />
                    );
                })}
            </ul>
        </aside>
    );
};

export { TableListSidebar };
export type { TableListItem };
