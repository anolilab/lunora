import type { ReactElement, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

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
 */
const TableListSidebar = ({ header, onReload, onSelect, prefix, reloadLabel, selected, tables }: TableListSidebarProps): ReactElement => {
    const t = useT();
    const [query, setQuery] = useState<string>("");

    const onQueryChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setQuery(event.target.value);
    }, []);

    const filtered = useMemo<ReadonlyArray<TableListItem>>(() => {
        const needle = query.trim().toLowerCase();

        return needle === "" ? tables : tables.filter((item) => item.name.toLowerCase().includes(needle));
    }, [query, tables]);

    return (
        <aside className="flex h-full w-60 shrink-0 flex-col border-e border-border bg-sidebar" data-testid={`${prefix}-table-list`}>
            {header}
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
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
            <ul className="flex flex-1 flex-col gap-px overflow-y-auto p-1.5">
                {filtered.map((item) => (
                    <TableListButton item={item} key={item.name} onSelect={onSelect} prefix={prefix} selected={selected === item.name} />
                ))}
            </ul>
        </aside>
    );
};

/** Default rows-per-page choices for the page-size selector. */
const PAGE_SIZE_OPTIONS: ReadonlyArray<number> = [25, 50, 100, 250];

/** The rows-per-page dropdown — a native select for keyboard and test friendliness. */
const PageSizeSelect = ({
    onChange,
    options,
    prefix,
    value,
}: {
    readonly onChange: (size: number) => void;
    readonly options: ReadonlyArray<number>;
    readonly prefix: string;
    readonly value: number;
}): ReactElement => {
    const t = useT();

    const onSelect = useCallback(
        (event: React.ChangeEvent<HTMLSelectElement>): void => {
            onChange(Number.parseInt(event.target.value, 10));
        },
        [onChange],
    );

    return (
        <label className="flex items-center gap-1.5" htmlFor={`${prefix}-page-size`}>
            <span>{t("Rows per page")}</span>
            <select
                className="h-6 rounded-md border border-border bg-background px-1 tabular-nums outline-none focus-visible:border-ring"
                data-testid={`${prefix}-page-size`}
                id={`${prefix}-page-size`}
                onChange={onSelect}
                value={value}
            >
                {options.map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </select>
        </label>
    );
};

/**
 * An editable "Page X of Y" control — type a page number to jump straight to it.
 * The input is uncontrolled (keyed by the current page so Prev/Next reset it) and
 * commits on Enter or blur, clamped to `[1, pages]`.
 */
const PageJump = ({
    onJump,
    page,
    pages,
    prefix,
}: {
    readonly onJump: (page: number) => void;
    readonly page: number;
    readonly pages: number;
    readonly prefix: string;
}): ReactElement => {
    const t = useT();

    const commit = useCallback(
        (raw: string): void => {
            const next = Number.parseInt(raw, 10);

            if (!Number.isNaN(next)) {
                onJump(Math.min(Math.max(1, next), Math.max(1, pages)));
            }
        },
        [onJump, pages],
    );

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>): void => {
            if (event.key === "Enter") {
                commit(event.currentTarget.value);
            }
        },
        [commit],
    );

    const onBlur = useCallback(
        (event: React.FocusEvent<HTMLInputElement>): void => {
            commit(event.currentTarget.value);
        },
        [commit],
    );

    return (
        <span className="flex items-center gap-1.5 tabular-nums">
            {t("Page")}
            <input
                aria-label={t("Page")}
                className="h-6 w-12 rounded-md border border-border bg-background px-1 text-center tabular-nums outline-none focus-visible:border-ring"
                data-testid={`${prefix}-page-jump`}
                defaultValue={page}
                key={page}
                max={Math.max(1, pages)}
                min={1}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                type="number"
            />
            {t("of {pages}", { pages })}
        </span>
    );
};

interface GridPaginationProps {
    readonly hasNext: boolean;
    readonly hasPrevious: boolean;
    /** Jump to a 1-based page. When set (with `pageSize`), the page-jump control replaces the static range text. */
    readonly onJumpToPage?: (page: number) => void;
    readonly onNext: () => void;
    /** Change the rows-per-page. When set (with `pageSize`), the rows-per-page selector is shown. */
    readonly onPageSizeChange?: (size: number) => void;
    readonly onPrevious: () => void;
    /** Current rows-per-page; enables the page-size selector + page-jump math when provided. */
    readonly pageSize?: number;
    /** Rows-per-page choices for the selector (defaults to {@link PAGE_SIZE_OPTIONS}). */
    readonly pageSizeOptions?: ReadonlyArray<number>;
    /** Scopes `data-testid`s: `{prefix}-prev`, `{prefix}-next`, `{prefix}-page-info`, `{prefix}-page-size`, `{prefix}-page-jump`. */
    readonly prefix: string;
    readonly rangeEnd: number;
    readonly rangeStart: number;
    readonly total: number;
}

/**
 * Supabase-style grid footer: an optional rows-per-page selector on the left, then
 * Previous · "x–y of N" (or an editable "Page X of Y" jump when `pageSize` +
 * `onJumpToPage` are supplied) · Next. The page-size and jump controls render only
 * when their callbacks are provided, so a simpler grid can pass just the Prev/Next
 * basics.
 */
const GridPagination = ({
    hasNext,
    hasPrevious,
    onJumpToPage,
    onNext,
    onPageSizeChange,
    onPrevious,
    pageSize,
    pageSizeOptions = PAGE_SIZE_OPTIONS,
    prefix,
    rangeEnd,
    rangeStart,
    total,
}: GridPaginationProps): ReactElement => {
    const t = useT();

    const buttonClass =
        "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

    const pages = pageSize !== undefined && pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    const page = pageSize !== undefined && pageSize > 0 ? Math.floor(Math.max(0, rangeStart - 1) / pageSize) + 1 : 1;

    return (
        <div className="flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
                {pageSize !== undefined && onPageSizeChange !== undefined && (
                    <PageSizeSelect onChange={onPageSizeChange} options={pageSizeOptions} prefix={prefix} value={pageSize} />
                )}
                <span className="tabular-nums" data-testid={`${prefix}-page-info`}>
                    {t("{rangeStart}-{rangeEnd} of {total}", { rangeEnd, rangeStart, total })}
                </span>
            </div>
            <div className="flex items-center gap-3">
                <button className={buttonClass} data-testid={`${prefix}-prev`} disabled={!hasPrevious} onClick={onPrevious} type="button">
                    {t("Previous")}
                </button>
                {pageSize !== undefined && onJumpToPage !== undefined && <PageJump onJump={onJumpToPage} page={page} pages={pages} prefix={prefix} />}
                <button className={buttonClass} data-testid={`${prefix}-next`} disabled={!hasNext} onClick={onNext} type="button">
                    {t("Next")}
                </button>
            </div>
        </div>
    );
};

/**
 * Container that frames a data grid (the table is passed as `children`). The
 * default mode is a bordered, rounded, horizontally-scrolling card — the look
 * Supabase's Table Editor uses, instead of a bare table bleeding into the page.
 * In `fill` mode it instead grows to fill its flex parent (`flex-1 min-h-0`) and
 * lets the child own scrolling, so a full-height table editor's grid stretches to
 * the bottom of the panel rather than being pinned to a fixed height.
 */
const GridContainer = ({
    children,
    fill = false,
    testId,
}: {
    readonly children: ReactNode;
    readonly fill?: boolean;
    readonly testId?: string;
}): ReactElement => (
    <div
        className={fill ? "flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border" : "overflow-x-auto rounded-md border border-border"}
        data-testid={testId}
    >
        {children}
    </div>
);

export { CellValue, GridContainer, GridPagination, TableListSidebar };
export type { TableListItem };
