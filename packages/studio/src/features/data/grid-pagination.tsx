import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";

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

    const onSelect = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        onChange(Number.parseInt(event.target.value, 10));
    };

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

    const commit = (raw: string): void => {
        const next = Number.parseInt(raw, 10);

        if (!Number.isNaN(next)) {
            onJump(Math.min(Math.max(1, next), Math.max(1, pages)));
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            commit(event.currentTarget.value);
        }
    };

    const onBlur = (event: React.FocusEvent<HTMLInputElement>): void => {
        commit(event.currentTarget.value);
    };

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

export default GridPagination;
