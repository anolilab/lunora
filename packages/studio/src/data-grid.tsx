import type { ReactElement, ReactNode } from "react";
import { useCallback } from "react";

import { useT } from "./i18n-context";
import { formatCell } from "./internal";

/**
 * One grid cell's value, rendered Outerbase/Supabase-style: a `null`/`undefined`
 * shows a muted italic `NULL` (so an absent value reads differently from an empty
 * string), everything else goes through {@link formatCell}. The raw text is set as
 * the cell `title` so a truncated value is recoverable on hover.
 */
const CellValue = ({ value }: { readonly value: unknown }): ReactElement => {
    if (value === null || value === undefined) {
        return <span className="text-muted-foreground/50 italic">NULL</span>;
    }

    return <span title={formatCell(value)}>{formatCell(value)}</span>;
};

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
}

/**
 * One sidebar table entry. Extracted so each binds its `onClick` through a stable
 * `useCallback` (closing over the table name) rather than a fresh inline closure.
 */
const TableListButton = ({ item, onSelect, prefix, selected }: TableListButtonProps): ReactElement => {
    const onClick = useCallback((): void => {
        onSelect(item.name);
    }, [item.name, onSelect]);

    return (
        <li>
            <button
                aria-pressed={selected}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent ${selected ? "bg-accent font-medium text-accent-foreground" : "text-foreground"}`}
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
 * The Supabase-style table sidebar: a bordered, scrollable list of the tables in
 * the current source, each a selectable row with its name and a row-count badge.
 * The active table is highlighted. Shared by the shard and global data browsers
 * so both read identically.
 */
const TableListSidebar = ({ onReload, onSelect, prefix, reloadLabel, selected, tables }: TableListSidebarProps): ReactElement => {
    const t = useT();

    return (
        <div className="flex w-56 shrink-0 flex-col self-start rounded-md border border-border bg-card" data-testid={`${prefix}-table-list`}>
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Tables")}</span>
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
            <ul className="flex max-h-[28rem] flex-col gap-px overflow-y-auto p-1.5">
                {tables.map((item) => (
                    <TableListButton item={item} key={item.name} onSelect={onSelect} prefix={prefix} selected={selected === item.name} />
                ))}
            </ul>
        </div>
    );
};

interface GridPaginationProps {
    readonly hasNext: boolean;
    readonly hasPrevious: boolean;
    readonly onNext: () => void;
    readonly onPrevious: () => void;
    /** Scopes `data-testid`s: `{prefix}-prev`, `{prefix}-next`, `{prefix}-page-info`. */
    readonly prefix: string;
    readonly rangeEnd: number;
    readonly rangeStart: number;
    readonly total: number;
}

/** Supabase-style grid footer: Previous · "x–y of N" · Next, in a bordered bar. */
const GridPagination = ({ hasNext, hasPrevious, onNext, onPrevious, prefix, rangeEnd, rangeStart, total }: GridPaginationProps): ReactElement => {
    const t = useT();

    const buttonClass =
        "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

    return (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <button className={buttonClass} data-testid={`${prefix}-prev`} disabled={!hasPrevious} onClick={onPrevious} type="button">
                {t("Previous")}
            </button>
            <span className="tabular-nums" data-testid={`${prefix}-page-info`}>
                {t("{rangeStart}-{rangeEnd} of {total}", { rangeEnd, rangeStart, total })}
            </span>
            <button className={buttonClass} data-testid={`${prefix}-next`} disabled={!hasNext} onClick={onNext} type="button">
                {t("Next")}
            </button>
        </div>
    );
};

/**
 * Bordered, horizontally-scrolling container that frames a data grid (the table
 * is passed as `children`). Gives every grid the same rounded border + scroll
 * affordance Supabase's Table Editor uses, instead of a bare table bleeding into
 * the page.
 */
const GridContainer = ({ children, testId }: { readonly children: ReactNode; readonly testId?: string }): ReactElement => (
    <div className="overflow-x-auto rounded-md border border-border" data-testid={testId}>
        {children}
    </div>
);

export { CellValue, GridContainer, GridPagination, TableListSidebar };
export type { TableListItem };
