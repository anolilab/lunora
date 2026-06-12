import type { GlobalTableInfo, GlobalTablePage } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAutoRefresh } from "../../hooks/use-auto-refresh";
import { useT } from "../../i18n/i18n-context";
import { CLOUDFLARE_D1_URL } from "../../lib/cf-links";
import { errorMessage, fireAndForget } from "../../lib/internal";
import { CellValue, GridContainer } from "./data-grid";
import GridPagination from "./grid-pagination";
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

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index.toString()}`;
};

/**
 * Read-only browser for `.global()` (D1-backed) tables. Twin of `DataBrowser`,
 * but not shard-scoped: it lists tables via `listGlobalTables()` and pages rows
 * via `readGlobalTablePage()`. Laid out like Supabase's Table Editor — a left
 * table sidebar + a bordered grid with a paginated footer — and gated by the
 * server's `CIRRUS_ADMIN_TOKEN`.
 */
export const GlobalDataBrowser = ({
    initialTable,
    onSelectTable,
    pageSize: initialPageSize = DEFAULT_PAGE_SIZE,
    schemaSwitch,
}: GlobalDataBrowserProps = {}): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [tables, setTables] = useState<GlobalTableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    // Seed from `initialTable` (a cross-tier ref jump from the Table editor) so the
    // initial selection comes from an initializer, never a synchronous setState in
    // an effect; the page itself is fetched in the mount effect below.
    const [selectedTable, setSelectedTable] = useState<null | string>(initialTable ?? null);
    const [offset, setOffset] = useState<number>(0);
    // Rows-per-page is user-adjustable via the footer's selector; the prop seeds it.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);
    const [page, setPage] = useState<GlobalTablePage | null>(null);
    const [pageError, setPageError] = useState<null | string>(null);

    const fetchTables = useCallback(async (): Promise<void> => {
        setTablesError(null);

        try {
            setTables(await client.listGlobalTables());
        } catch (error) {
            setTables(null);
            setTablesError(errorMessage(error));
        }
    }, [client]);

    const fetchPage = useCallback(
        async (table: string, nextOffset: number, limit: number = pageSize): Promise<void> => {
            setPageError(null);

            try {
                const result = await client.readGlobalTablePage({ limit, offset: nextOffset, table });

                setPage(result);
                setOffset(nextOffset);
            } catch (error) {
                setPage(null);
                setPageError(errorMessage(error));
            }
        },
        [client, pageSize],
    );

    useEffect(() => {
        fireAndForget(fetchTables());
    }, [fetchTables]);

    // D1 is HTTP-only (no subscription channel), so poll to keep the table list
    // and the current page current without a manual reload — `useAutoRefresh`
    // pauses while the tab is hidden. The tick closure is held in a ref, so it
    // always sees the latest selection/offset.
    useAutoRefresh(() => {
        fireAndForget(fetchTables());

        if (selectedTable !== null) {
            fireAndForget(fetchPage(selectedTable, offset));
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
            fireAndForget(fetchPage(table, 0));
            // Mirror the selection to the URL so it's shareable and back/forward works.
            onSelectTable?.(table);
        },
        [fetchPage, onSelectTable],
    );

    // Reconcile the `initialTable` the Table editor hands us via the URL into the
    // selection: a cross-tier `v.id` ref jump, a deep link, or browser back/forward.
    // It defers to `selectTable`, which sets BOTH `selectedTable` (so the sidebar
    // highlight and pagination track the displayed table) and fetches its page — a
    // bare `fetchPage` here would desync the two on back/forward while the browser
    // stays mounted. Applied once per distinct value (ref claimed up front), so a
    // page-size change or a value this component itself just selected doesn't re-run.
    //
    // NB: structurally identical to the shard hook's URL-reconcile effect
    // (`use-data-browser`); both defer via `queueMicrotask` so the select's setStates
    // don't run synchronously in the effect. Kept inline rather than shared because
    // each browser's `selectTable` differs (the shard one also resets sort/filter/
    // staged state and is shard-keyed); only this ~6-line wiring would be common.
    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- URL → selection sync: open the global table named in the URL (cross-tier jump / deep link / back-forward). A given value applies at most once (ref-guarded); there is no user event to hook into. */
        if (initialTable === undefined || initialTable === "" || appliedInitialTable.current === initialTable) {
            return;
        }

        appliedInitialTable.current = initialTable;
        const target = initialTable;

        queueMicrotask(() => {
            selectTable(target);
        });
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
    }, [initialTable, selectTable]);

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            fireAndForget(fetchPage(selectedTable, Math.max(0, nextOffset)));
        },
        [fetchPage, selectedTable],
    );

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const reloadTables = useCallback((): void => {
        fireAndForget(fetchTables());
    }, [fetchTables]);

    const goPrevious = useCallback((): void => {
        goToPage(offset - pageSize);
    }, [goToPage, offset, pageSize]);

    const goNext = useCallback((): void => {
        goToPage(offset + pageSize);
    }, [goToPage, offset, pageSize]);

    const jumpToPage = useCallback(
        (targetPage: number): void => {
            goToPage(Math.max(0, (targetPage - 1) * pageSize));
        },
        [goToPage, pageSize],
    );

    // Change rows-per-page and re-read the first page at the new size (passed
    // explicitly so it doesn't wait for the state-updated closure).
    const changePageSize = useCallback(
        (size: number): void => {
            setPageSize(size);

            if (selectedTable !== null) {
                fireAndForget(fetchPage(selectedTable, 0, size));
            }
        },
        [fetchPage, selectedTable],
    );

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-global-data-browser">
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
        </div>
    );
};

export type { GlobalDataBrowserProps };
