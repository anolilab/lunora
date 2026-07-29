import type { GlobalFacetResult, GlobalFilterClause, GlobalTableInfo, GlobalTablePage } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useClientQuery } from "../../hooks/use-admin-query";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_D1_URL } from "../../lib/cf-links";
import DataFacets from "./data-facets";
import { CellValue, GridContainer } from "./data-grid";
import GridPagination from "./grid-pagination";
import { useFacets } from "./hooks/use-facets";
import { TableListSidebar } from "./table-list-sidebar";

interface GlobalDataBrowserProps {
    /**
     * Table to open automatically on mount (and whenever it changes). Used by the
     * Table editor when a `v.id` reference in a shard row points at a `.global()`
     * table: clicking it switches to the global tier and lands here with that table
     * pre-selected. Each distinct value is applied once, so the operator can still
     * navigate away afterwards.
     */
    readonly initialTable?: string;

    /**
     * Called whenever the open table changes, so the host can mirror it to the URL
     * (the Table editor pushes `?table=…`). Omitted in standalone use.
     */
    readonly onSelectTable?: (table: string) => void;
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;

    /**
     * The schema/source selector rendered at the top of the table-list sidebar —
     * the Table editor's `schema public ▾` switch. Supplied when this browser is
     * composed into the Table editor; omitted when it's used alone.
     */
    readonly schemaSwitch?: ReactNode;
}

const DEFAULT_PAGE_SIZE = 50;

/** Hoisted empty table list — a stable reference for the "no tables yet" sidebar (avoids a fresh `[]` literal in JSX). */
const NO_TABLES: ReadonlyArray<GlobalTableInfo> = [];

/** Hoisted empty column list — a stable `DataFacets` fallback before a page loads (avoids a fresh `[]` literal in JSX). */
const NO_COLUMNS: ReadonlyArray<string> = [];

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index.toString()}`;
};

/** Render a facet/filter value for a removable chip, distinguishing NULL and the empty string from a real value. */
const chipValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "∅";
    }

    if (value === "") {
        return "(empty)";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-object primitives stringify meaningfully; objects are handled above.
    return String(value);
};

/**
 * Read-only browser for `.global()` (D1-backed) tables. Twin of `DataBrowser`,
 * but not shard-scoped: it lists tables via `listGlobalTables()` and pages rows
 * via `readGlobalTablePage()`. Laid out like Supabase's Table Editor — a left
 * table sidebar + a bordered grid with a paginated footer — and gated by the
 * server's `LUNORA_ADMIN_TOKEN`.
 */
export const GlobalDataBrowser = ({
    initialTable,
    onSelectTable,
    pageSize: initialPageSize = DEFAULT_PAGE_SIZE,
    schemaSwitch,
}: GlobalDataBrowserProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    // Seed from `initialTable` (a cross-tier ref jump from the Table editor) so the
    // initial selection comes from an initializer, never a synchronous setState in
    // an effect; the page query refetches itself once a table is selected.
    const [selectedTable, setSelectedTable] = useState<null | string>(initialTable ?? null);
    const [offset, setOffset] = useState<number>(0);
    // Rows-per-page is user-adjustable via the footer's selector; the prop seeds it.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);

    // Active drill-down: the `column = value` eq constraints a facet-value click
    // adds. Unlike the shard browser there's no free-form filter bar — these come
    // only from facet clicks (and their removable chips). Mirrored into a ref so the
    // page/facet fetches and the poll tick read the latest set without re-binding.
    const [filters, setFilters] = useState<GlobalFilterClause[]>([]);
    const filtersRef = useRef(filters);

    // Mirrored in an EFFECT, not during render: React may render without
    // committing, and a render-phase write would publish a value from a render
    // that never became the UI. The handlers below still assign directly — a
    // write inside an event handler is already outside render.
    useEffect(() => {
        filtersRef.current = filters;
    });

    // Datasette-style per-column value/count summaries the operator has toggled on.
    // Opt-in per column (faceting a wide column is costly); each reflects the active
    // view (the same filters the grid is showing). The shared `useFacets` hook owns
    // the slot transitions and exposes a ref so the filter-mutation handlers and
    // poll tick can refetch the open ones; only the per-view fetch call is ours.
    const { clearFacets, facets, refetchFacets: refetchFacetsViaHook, toggleFacet } = useFacets();

    // ── Reads via TanStack Query (`useClientQuery`): the D1 browser is HTTP-only
    // (no live channel), so these are one-shot reads polled by `useAutoRefresh`
    // below. The page query's key IS the view (table / offset / size / filters), so
    // selecting a table or paginating / drilling down transparently refetches.
    const tablesQuery = useClientQuery<GlobalTableInfo[]>(["lunora-global-tables"], () => client.listGlobalTables());
    const tables = tablesQuery.data ?? null;
    const tablesError = tablesQuery.error;

    // `keepPreviousData` is off: the placeholder isn't table-aware, so holding the
    // last page across a `selectedTable` change would render table A's rows while
    // the sidebar/URL already point at table B (and facet clicks would then act on
    // the new table using the stale visible rows). Disabled until a table is open.
    const pageQuery = useClientQuery<GlobalTablePage>(
        ["lunora-global-page", selectedTable ?? "", offset, pageSize, JSON.stringify(filters)],
        () => client.readGlobalTablePage({ filters, limit: pageSize, offset, table: selectedTable ?? "" }),
        { enabled: selectedTable !== null, keepPreviousData: false },
    );
    const page = pageQuery.data ?? null;
    const pageError = pageQuery.error;

    // A column's facet summary is fetched over the active view via `facetGlobalColumn`.
    // `GlobalFacetResult` is structurally the studio's `FacetResult`, so it drops
    // straight into `FacetState`. This builds the per-view fetcher the shared hook drives.
    const facetFetcher =
        (table: string, activeFilters: GlobalFilterClause[]): ((column: string) => Promise<GlobalFacetResult>) =>
        (column) =>
            client.facetGlobalColumn({ column, filters: activeFilters, table });

    // Refetch every toggled-on facet for the active view — called after a filter
    // changes (and on each poll tick) so the summaries track the previewed rows.
    const refetchFacets = (table: string, activeFilters: GlobalFilterClause[]): void => {
        refetchFacetsViaHook(facetFetcher(table, activeFilters));
    };

    // D1 is HTTP-only (no subscription channel), so poll to keep the table list
    // and the current page current without a manual reload — `useAutoRefresh`
    // pauses while the tab is hidden. The tick closure is held in a ref, so it
    // always sees the latest selection/filters; it re-runs the two TanStack reads
    // and the open facets.
    useAutoRefresh(() => {
        tablesQuery.refetch();

        if (selectedTable !== null) {
            pageQuery.refetch();
            refetchFacets(selectedTable, filtersRef.current);
        }
    }, true);

    // The table last applied to the selection (cross-tier jump, deep link, or
    // back/forward). Lets the URL-reconcile effect skip values this component itself
    // already opened, and is set by `selectTable` so a user click doesn't re-fetch
    // when the same value bounces back in via the `initialTable` prop.
    const appliedInitialTable = useRef<string | undefined>(undefined);

    const selectTable = useCallback(
        (table: string): void => {
            setSelectedTable(table);
            appliedInitialTable.current = table;
            // A fresh table means the previous drill-down filters and facets no longer apply.
            setFilters([]);
            filtersRef.current = [];
            clearFacets();
            // Reset to the first page in the handler (not an effect); the page query
            // refetches itself once `selectedTable`/`offset`/`filters` change.
            setOffset(0);
            // Mirror the selection to the URL so it's shareable and back/forward works.
            onSelectTable?.(table);
        },
        [clearFacets, onSelectTable],
    );

    // Toggle a column into / out of the facet sidebar. Turning it on seeds a loading
    // slot and fetches its summary for the active view; turning it off drops it. With
    // no table selected the hook seeds the slot without fetching (a null fetcher).
    const onToggleFacet = (column: string): void => {
        toggleFacet(column, selectedTable === null ? null : facetFetcher(selectedTable, filtersRef.current));
    };

    // Apply a new filter set: jump back to the first page (in the handler, not an
    // effect — the page query refetches on the `filters`/`offset` change) and refetch
    // the open facets so both reflect the drill-down. `next` is passed explicitly to
    // the facet refetch (state is async).
    const applyFilters = (next: GlobalFilterClause[]): void => {
        setFilters(next);
        filtersRef.current = next;
        setOffset(0);

        if (selectedTable !== null) {
            refetchFacets(selectedTable, next);
        }
    };

    // Clicking a facet value adds an `eq` filter for that column/value, narrowing the
    // view. Replaces any existing clause for the same column so repeated clicks don't stack.
    const onFacetFilter = (column: string, value: unknown): void => {
        applyFilters([...filtersRef.current.filter((clause) => clause.column !== column), { column, value }]);
    };

    // Remove one active drill-down filter (its chip's ✕).
    const removeFilter = (event: MouseEvent<HTMLButtonElement>): void => {
        const index = Number(event.currentTarget.dataset["index"]);

        applyFilters(filtersRef.current.filter((_, position) => position !== index));
    };

    // Reconcile the `initialTable` the Table editor hands us via the URL into the
    // selection: a cross-tier `v.id` ref jump, a deep link, or browser back/forward.
    // It defers to `selectTable`, which sets `selectedTable` (so the sidebar
    // highlight and pagination track the displayed table) and resets the view — the
    // page query then refetches off that state change. Setting `selectedTable`
    // directly here would skip the filter/facet/offset reset. Applied once per
    // distinct value (ref claimed up front), so a
    // page-size change or a value this component itself just selected doesn't re-run.
    //
    // NB: structurally identical to the shard hook's URL-reconcile effect
    // (`use-data-browser`); both defer via `queueMicrotask` so the select's setStates
    // don't run synchronously in the effect. Kept inline rather than shared because
    // each browser's `selectTable` differs (the shard one also resets sort/filter/
    // staged state and is shard-keyed); only this ~6-line wiring would be common.
    //
    // `selectTable` is read via a ref so the effect fires on `initialTable` changes
    // ALONE. Its identity churns with the host's per-render `onSelectTable`, and
    // depending on it re-ran the effect in the window between a user click (which
    // claims `appliedInitialTable` optimistically) and the async URL commit — the
    // stale `initialTable` then reverted the selection to the previous table.
    const selectTableRef = useRef(selectTable);

    // Keep the ref pointing at the latest `selectTable` from an effect, not
    // during render — a render-phase ref write is impure (React can replay or
    // discard the render). This effect runs after every commit, so the ref is
    // fresh before the `[initialTable]` effect's deferred `queueMicrotask` fires.
    useEffect(() => {
        selectTableRef.current = selectTable;
    });

    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- URL → selection sync: open the global table named in the URL (cross-tier jump / deep link / back-forward). A given value applies at most once (ref-guarded); there is no user event to hook into. */
        if (initialTable === undefined || initialTable === "" || appliedInitialTable.current === initialTable) {
            return;
        }

        appliedInitialTable.current = initialTable;
        const target = initialTable;

        queueMicrotask(() => {
            selectTableRef.current(target);
        });
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
    }, [initialTable]);

    const goToPage = (nextOffset: number): void => {
        if (selectedTable === null) {
            return;
        }

        // The page query is keyed on `offset`, so setting it refetches that page.
        setOffset(Math.max(0, nextOffset));
    };

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const reloadTables = (): void => {
        tablesQuery.refetch();
    };

    const goPrevious = (): void => {
        goToPage(offset - pageSize);
    };

    const goNext = (): void => {
        goToPage(offset + pageSize);
    };

    const jumpToPage = (targetPage: number): void => {
        goToPage(Math.max(0, (targetPage - 1) * pageSize));
    };

    // Change rows-per-page and jump back to the first page (in the handler, not an
    // effect); the page query is keyed on `pageSize`/`offset`, so it refetches the
    // first page at the new size.
    const changePageSize = (size: number): void => {
        setPageSize(size);
        setOffset(0);
    };

    return (
        <div className="flex h-full min-w-0" data-testid="lunora-global-data-browser">
            <TableListSidebar
                header={
                    <div className="flex shrink-0 flex-col items-stretch gap-2 border-b border-border p-3">
                        {schemaSwitch}
                        <a
                            className="text-sm text-primary underline-offset-4 hover:underline"
                            data-testid="gdb-cf-link"
                            href={CLOUDFLARE_D1_URL}
                            rel="noreferrer"
                            target="_blank"
                        >
                            {t("Open in Cloudflare")}
                        </a>
                    </div>
                }
                onReload={reloadTables}
                onSelect={selectTable}
                prefix="gdb"
                selected={selectedTable}
                tables={tables ?? NO_TABLES}
            />

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {tablesError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="gdb-tables-error" role="alert">
                        {tablesError}
                    </p>
                )}

                {tables !== null && tables.length === 0 && (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <EmptyState
                            description={t("Tables marked .global() (D1-backed, region-replicated) will appear here.")}
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
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
                                </svg>
                            }
                            testId="gdb-empty"
                            title={t("No global tables.")}
                        />
                    </div>
                )}

                {pageError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="gdb-page-error" role="alert">
                        {pageError}
                    </p>
                )}

                {tables !== null && tables.length > 0 && page === null && pageError === null && (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <p className="text-sm text-muted-foreground">{t("Select a table to browse its rows.")}</p>
                    </div>
                )}

                {page !== null && (
                    <div className="flex min-h-0 flex-1 flex-col" data-testid="gdb-page">
                        {filters.length > 0 && (
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 text-xs" data-testid="gdb-filters">
                                {filters.map((filter, index) => (
                                    <span
                                        className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5"
                                        data-testid="gdb-filter-chip"
                                        key={`${filter.column}:${chipValue(filter.value)}`}
                                    >
                                        <span className="font-medium text-foreground">{filter.column}</span>
                                        <span className="text-muted-foreground">=</span>
                                        <span className="font-mono text-foreground">{chipValue(filter.value)}</span>
                                        <button
                                            aria-label={t("Remove filter")}
                                            className="ml-0.5 text-muted-foreground hover:text-foreground"
                                            data-index={index}
                                            data-testid="gdb-filter-remove"
                                            onClick={removeFilter}
                                            type="button"
                                        >
                                            ✕
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}

                        <GridContainer layout="fill">
                            <div className="min-h-0 flex-1 overflow-auto">
                                <Table data-testid="gdb-rows">
                                    <TableHeader>
                                        <TableRow>
                                            {page.columns.map((column) => (
                                                <TableHead key={column}>{column}</TableHead>
                                            ))}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {page.rows.map((row, rowIndex) => (
                                            <TableRow data-testid="gdb-row" key={rowKey(row, rowIndex)}>
                                                {page.columns.map((column) => (
                                                    <TableCell className="max-w-xs truncate font-mono text-xs" key={column}>
                                                        <CellValue value={row[column]} />
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </GridContainer>

                        <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
                            <GridPagination
                                hasNext={hasNext}
                                hasPrevious={hasPrevious}
                                onJumpToPage={jumpToPage}
                                onNext={goNext}
                                onPageSizeChange={changePageSize}
                                onPrevious={goPrevious}
                                pageSize={pageSize}
                                prefix="gdb"
                                rangeEnd={rangeEnd}
                                rangeStart={rangeStart}
                                total={total}
                            />
                        </div>
                    </div>
                )}
            </div>

            <DataFacets columns={page?.columns ?? NO_COLUMNS} facets={facets} onFacetFilter={onFacetFilter} onToggleFacet={onToggleFacet} />
        </div>
    );
};

export type { GlobalDataBrowserProps };
