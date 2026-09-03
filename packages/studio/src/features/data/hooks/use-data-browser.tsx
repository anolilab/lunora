import type { FunctionReference } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";

// Bundler-inlined shared helper (see CLAUDE.md `shared/` rules) — the same wire
// codec the shard writer stores `__doc__` with, so display and save agree on the
// encoding rather than studio growing a second, drifting decoder.
import { drainBulkOp } from "../../../../../../shared/bulk-drain";
import { decodeDocument, decodeWire, encodeWire, isPlainObject } from "../../../../../../shared/wire-codec";
import { useAdminQuery } from "../../../hooks/use-admin-query";
import useDebounced from "../../../hooks/use-debounced";
import useMirroredRef from "../../../hooks/use-mirrored-ref";
import type { BulkRowOpResult, FacetResult, FilterClause, TableInfo, TablePage, WriteRowResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import type { DataView } from "../../../lib/saved-queries";
import { recordShard } from "../../../lib/shard-history";
import type { DataBrowserTableModel, TableRow } from "../data-browser-grid";
import { rowId, useDataBrowserTable } from "../data-browser-grid";
import type { EditableFilter } from "../data-filters";
import { toFilterClauses } from "../data-filters";
import type { StagedChange, StagedEditsModel } from "../staged-edits";
import { useStagedEdits } from "../staged-edits";
import type { FacetFetcher, FacetState } from "./use-facets";
import { useFacets } from "./use-facets";

/**
 * Convert TanStack's sorting state into the `readTablePage` `orderBy` arg. The
 * grid sorts by a single column, so only the first sort entry is used; an empty
 * state (no active sort) maps to `undefined` → the server's natural order.
 */
const toOrderBy = (sorting: SortingState): undefined | { column: string; direction: "asc" | "desc" } => {
    const first = sorting[0];

    return first === undefined ? undefined : { column: first.id, direction: first.desc ? "desc" : "asc" };
};

/**
 * Coerce a clicked facet value into the string an `EditableFilter` carries (the
 * filter bar's values are strings until coerced for the wire). NULL/undefined map
 * to the empty string; objects are JSON-encoded so they don't stringify to
 * `[object Object]`.
 */
const facetValueText = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-object primitives stringify meaningfully; objects are handled above
    return String(value);
};

/**
 * Hydrate the filter bar from URL/saved-query {@link FilterClause}s. The inverse
 * of `toFilterClauses`: the bar's value is always a string (it re-coerces numbers
 * on the wire), so every clause value is stringified back. Objects can't appear
 * on a real clause value, but are JSON-encoded defensively.
 */
const toEditableFilters = (clauses: ReadonlyArray<FilterClause>): EditableFilter[] =>
    clauses.map((clause) => {
        return { column: clause.column, operator: clause.operator, value: clause.value === undefined ? "" : facetValueText(clause.value) };
    });

/** Translate a single-sort `orderBy` into the TanStack sorting state the grid renders. */
const fromOrderBy = (orderBy: DataView["orderBy"]): SortingState => (orderBy === undefined ? [] : [{ desc: orderBy.direction === "desc", id: orderBy.column }]);

/**
 * A {@link FilterClause} reduced to a fixed-shape tuple. `JSON.stringify` of an
 * object literal preserves THAT object's own key insertion order, which two
 * structurally-equal clauses need not share (e.g. one parsed from a URL's JSON
 * blob) — serializing a tuple instead means two equal clauses always produce
 * the same string, regardless of where they came from.
 */
const filterClauseTuple = (clause: FilterClause): [string, string, unknown] => [clause.column, clause.operator, clause.value];

/**
 * Serialize the fields a data-browser view is keyed on (shard / search /
 * filters / sort) into one comparable string. Used both for "what view is
 * incoming right now" (from props) and "what view is this component currently
 * emitting to the host" (from local state) so the render-time re-seed check
 * below can tell an actual apply from the URL mirror's own echo. Built from
 * fixed-shape tuples/arrays throughout (never a bare object), so two views
 * that are equal in value always serialize identically.
 */
const serializeView = (
    shard: string | undefined,
    search: string | undefined,
    filters: ReadonlyArray<FilterClause> | undefined,
    orderBy: DataView["orderBy"],
): string =>
    JSON.stringify([
        shard ?? "",
        search ?? "",
        (filters ?? []).map((clause) => filterClauseTuple(clause)),
        orderBy === undefined ? null : [orderBy.column, orderBy.direction],
    ]);

/**
 * Hard ceiling on the number of bounded server `deleteRows`/`clearTable`/
 * `patchRows` calls one bulk action loops through, so "delete matching" /
 * "clear table" / "set matching" can never run unbounded. Each call writes up to
 * the server's per-call cap (500 rows) and reports `hasMore`; the client loops
 * the single round-trip — never per-row.
 */
const MAX_BULK_BATCHES = 200;

/**
 * How many rows the FK hover preview fetches to find an exact primary-key match.
 * The `search` arg is a substring match across all columns, so a handful of
 * coincidental hits may precede the real row; this window is large enough to
 * contain it while staying a single cheap read.
 */
const PREVIEW_CANDIDATES = 20;

const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const FACET_COLUMN = adminRef(ADMIN_FUNCTIONS.facetColumn);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);
const DELETE_ROWS = adminRef(ADMIN_FUNCTIONS.deleteRows);
const CLEAR_TABLE = adminRef(ADMIN_FUNCTIONS.clearTable);
const PATCH_ROWS = adminRef(ADMIN_FUNCTIONS.patchRows);

/** Stable empty args for the no-argument `listTables` read (avoids a fresh object each render). */
const NO_ARGS: Record<string, unknown> = {};

/**
 * Columns that are never inline-editable: the primary-key aliases, the creation
 * timestamp, and the raw `__doc__` blob. Everything else is a user doc field and
 * can be edited in place (the edit stages a patch of just that field).
 */
const META_COLUMNS = new Set<string>(["__doc__", "__id__", "_creationTime", "_id", "id"]);

/**
 * The editable document for a row. Shard rows keep their fields in a `__doc__`
 * JSON column; when present we parse it, otherwise we fall back to the row's own
 * non-meta columns. Used to prefill the edit form.
 *
 * `decodeWire` mirrors the codec the shard writer stores with, so a `v.bigint()`
 * or `v.bytes()` field arrives as its value rather than the raw tagged array. It
 * is a no-op on a tree with no sentinel, so a plain-JSON document is unchanged.
 */
const rowDocument = (row: TableRow): Record<string, unknown> => {
    const raw = row["__doc__"];

    if (typeof raw === "string") {
        const parsed = decodeDocument(raw);

        if (parsed !== undefined) {
            return parsed;
        }
    }

    const fields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (!META_COLUMNS.has(key)) {
            fields[key] = value;
        }
    }

    return fields;
};

/**
 * Identity of a bulk request, for parking its resume cursor.
 *
 * `encodeWire` rather than a bare `JSON.stringify`: a `v.bigint()` / `v.bytes()`
 * value in the patch document is exactly what the dialog's `decodeWire` produces,
 * and `JSON.stringify` THROWS on a BigInt. That throw used to happen before the
 * drain's `try`, so `fireAndForget` swallowed it and the whole op became a silent
 * no-op — no request, no error, no notice.
 *
 * The shard is part of the key because it travels out-of-band in `callOptions`,
 * not in `args`: without it, a cursor parked against shard A would be replayed
 * against shard B's identical request and skip every row sorting below it.
 */
const bulkResumeKey = (reference: FunctionReference, args: Record<string, unknown>, shardKey: string): string =>
    JSON.stringify([reference.__lunoraRef, shardKey, encodeWire(args)]);

/** Everything {@link useDataBrowser} exposes to the `DataBrowser` render. */
interface DataBrowserModel {
    addRow: () => void;
    bulkDelete: () => void;
    /** Shallow-merge these fields into every row matching the active filters/search. */
    bulkPatch: (document_: Record<string, unknown>) => void;
    cancelCellEdit: () => void;
    cancelEdit: () => void;
    changePageSize: (size: number) => void;
    clearTable: () => void;
    columns: string[];
    committing: boolean;
    /** The currently-displayed view (table/shard/filters/search/sort) — for "Copy link" and "Save query". */
    currentView: DataView;
    discardStaged: () => void;
    editableColumn: (column: string) => boolean;
    editing: null | { docText: string; id: null | string };
    editingCell: null | { column: string; rowId: string };
    /** Add an `eq` filter for `column = value` (a facet-value click), appending to the active filters. */
    facetFilter: (column: string, value: unknown) => void;
    /** Per-column facet state for every toggled-on column; absent → not faceting that column. */
    facets: Record<string, FacetState>;
    filter: string;
    filters: EditableFilter[];
    goNext: () => void;
    goPrevious: () => void;
    hasNext: boolean;

    /**
     * Whether the view carries a predicate the bulk ops would actually send.
     *
     * Derived from the DEBOUNCED `search` (plus the structured filters), not the
     * raw search box: `bulkDelete`/`bulkPatch` send the debounced value, so
     * gating their buttons on the raw one put "Delete N matching" on screen for
     * up to 300ms with an empty predicate — a whole-table delete behind the
     * predicate button's confirm, bypassing the separate `Clear all N rows?` one.
     * Guard and request read the same value here by construction.
     */
    hasPredicate: boolean;
    hasPrevious: boolean;
    jumpToPage: (page: number) => void;
    liveError: string | undefined;
    loadTables: () => void;
    navigateToRef: (target: string, id: string) => void;
    onBulkDeleteSelected: (ids: ReadonlyArray<string>) => void;
    onCommitStaged: () => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onRowDelete: (id: null | string) => void;
    onRowEdit: (id: null | string, original: TableRow) => void;
    page: TablePage | null;
    pageError: null | string;
    pageSize: number;
    previewRef: (target: string, id: string) => Promise<Record<string, unknown> | null>;

    /**
     * The shard the reads actually target — `shardKey` after the debounce. Anything
     * that queries alongside the page (back-relation counts, say) must key on THIS,
     * or it fires per keystroke and can resolve against a shard whose rows are not
     * the ones on screen.
     */
    queryShardKey: string;
    rangeEnd: number;
    rangeStart: number;
    saveEdit: () => void;
    selectedTable: null | string;
    selectTable: (table: string) => void;
    setEditorDocumentText: (text: string) => void;
    setShardKey: (value: string) => void;
    shardKey: string;
    showJson: () => void;
    showTable: () => void;
    stage: StagedEditsModel["stage"];
    stagedChanges: StagedChange[];
    stagedValue: StagedEditsModel["stagedValue"];
    startCellEdit: (rowId: string, column: string) => void;
    table: DataBrowserTableModel;
    tables: TableInfo[] | null;
    tablesError: null | string;
    /** Toggle a column into / out of the facet sidebar (fetches its summary when turned on). */
    toggleFacet: (column: string) => void;
    total: number;
    viewMode: "json" | "table";
    writeError: null | string;
    /** Outcome line for the last completed bulk op — how many rows it actually wrote. */
    writeNotice: null | string;
}

/** The `readTablePage` arguments for the displayed view. */
const toPageArgs = ({
    filters,
    offset,
    pageSize,
    search,
    sorting,
    table,
}: {
    filters: ReadonlyArray<EditableFilter>;
    offset: number;
    pageSize: number;
    search: string;
    sorting: SortingState;
    table: string;
}): Record<string, unknown> => {
    return {
        filters: toFilterClauses(filters),
        limit: pageSize,
        offset,
        orderBy: toOrderBy(sorting),
        search,
        // The page read skips the COUNT — the total rides a separate
        // predicate-keyed query (`countArgs`) that page navigation never
        // re-keys, so paging no longer re-runs the full-table COUNT.
        skipCount: true,
        table,
    };
};

/** The predicate-only arguments for the row-count read, so paging never re-keys the COUNT. */
const toCountArgs = ({ filters, search, table }: { filters: ReadonlyArray<EditableFilter>; search: string; table: string }): Record<string, unknown> => {
    return {
        filters: toFilterClauses(filters),
        limit: 1,
        search,
        table,
    };
};

/** Resolve the staged buffer against the loaded page for the old-to-new diff. */
const resolveStagedChanges = (page: TablePage | null, staged: StagedEditsModel["staged"]): StagedChange[] => {
    const rowsById = new Map<string, TableRow>();

    for (const row of page?.rows ?? []) {
        const id = rowId(row);

        if (id !== null) {
            rowsById.set(id, row);
        }
    }

    const changes: StagedChange[] = [];

    for (const [id, columns] of Object.entries(staged)) {
        for (const [column, newValue] of Object.entries(columns)) {
            changes.push({ column, newValue, oldValue: rowsById.get(id)?.[column], rowId: id });
        }
    }

    return changes;
};

/** Whether a column is editable in place — every column but the meta ones. */
const editableColumn = (column: string): boolean => !META_COLUMNS.has(column);

/** Shown when a delete drain hits its batch bound. Re-running always makes progress: the removed rows no longer match. */
const DELETE_TRUNCATED = `Stopped after ${MAX_BULK_BATCHES.toString()} batches — rows still match. Run it again to remove the rest.`;

/** Shown when a patch drain hits its batch bound. Re-running resumes from the parked cursor rather than rescanning. */
const PATCH_TRUNCATED = `Stopped after ${MAX_BULK_BATCHES.toString()} batches — rows still match. Run it again to set the rest.`;

/**
 * How a bulk drain reports itself: the verb for the outcome banner, the notice
 * shown when the batch bound is hit, and whether the op resumes.
 *
 * `resumable` is what decides whether a cursor is sent at all. A delete does not
 * need one — its own writes remove rows from the predicate — and ordering its scan
 * would cost the server a sequential table scan (see `selectMatchingIds`).
 */
interface BulkDrainSpec {
    readonly resumable: boolean;
    readonly truncated: string;
    readonly verb: string;
}

const DELETE_DRAIN: BulkDrainSpec = { resumable: false, truncated: DELETE_TRUNCATED, verb: "deleted" };
const PATCH_DRAIN: BulkDrainSpec = { resumable: true, truncated: PATCH_TRUNCATED, verb: "written" };

const useDataBrowser = ({
    initialFilters,
    initialOrderBy,
    initialSearch,
    initialShardKey,
    onSelectTable,
    onViewChange,
    pageSize: initialPageSize,
    resolveBackRelations,
    tableParam,
}: {
    /** Structured filters to hydrate from a shared link / saved query. */
    initialFilters: FilterClause[] | undefined;
    /** Sort to hydrate from a shared link / saved query. */
    initialOrderBy: DataView["orderBy"];

    /** Substring search to hydrate from a shared link / saved query. */
    initialSearch: string | undefined;
    initialShardKey: string | undefined;

    /**
     * Navigate the URL to a table. The host opens it clean (dropping the previous
     * table's filters/sort/search); pass `options.search` to pre-fill the search
     * (an FK-cell traversal). The new view is re-seeded from the resulting URL.
     */
    onSelectTable: ((table: string, options?: { search?: string }) => void) | undefined;

    /**
     * Called whenever the loaded view (shard / search / filters / sort) changes, so
     * the host can mirror the full view state to the URL — making every view a real,
     * shareable link. Fires only for the actually-displayed view (the `loaded`
     * descriptor), never a half-typed shard key.
     */
    onViewChange: ((view: Pick<DataView, "filters" | "orderBy" | "search" | "shard">) => void) | undefined;

    pageSize: number;

    /**
     * Reverse relations switched on for a given table, rendered as extra columns.
     * A callback rather than a resolved list because the caller cannot know the
     * active table until this hook returns it.
     */
    resolveBackRelations?: (table: string) => ReadonlyArray<{ column: string; table: string }>;
    /** The table named in the URL — drives the selection so browser back/forward works. */
    tableParam: string | undefined;
}): DataBrowserModel => {
    const client = useLunora();

    // Rows-per-page is user-adjustable (the pagination footer's selector); the
    // prop seeds the initial value. Changing it re-fetches the first page.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");

    // The open table is DERIVED from the URL — the single source of truth. There is
    // no optimistic local `selectedTable` state mirrored back to the URL: that
    // optimistic copy raced the async navigation (a rapid table switch could
    // commit an older nav and bounce the selection). With the URL authoritative,
    // `selectTable` only navigates and the table can never disagree with the URL.
    const selectedTable: null | string = tableParam === undefined || tableParam === "" ? null : tableParam;
    const [offset, setOffset] = useState<number>(0);
    const [viewMode, setViewMode] = useState<"json" | "table">("table");

    // Page-local sort: operates ONLY on the rows of the currently loaded page.
    // Reset whenever a new table is selected so stale state can't leak across
    // selections.
    const [sorting, setSorting] = useState<SortingState>(() => fromOrderBy(initialOrderBy));

    // Search box value; debounced (below, into `search`) after the structured
    // filters / facets / staged-edit state it resets alongside on a table switch
    // are all in scope.
    const [filter, setFilter] = useState<string>(initialSearch ?? "");

    // Structured column filters. `bulkDelete` / `toggleFacet` read this state
    // directly (both are recreated every render and read it synchronously, never
    // across an `await`), same as the page query via `pageArgs`.
    const [filters, setFilters] = useState<EditableFilter[]>(() => toEditableFilters(initialFilters ?? []));

    // Facets (Datasette-style per-column value/count summaries): the columns the
    // operator has toggled into the facet sidebar, each with its loaded summary.
    // Opt-in per column (faceting a wide column is costly); the summaries reflect
    // the ACTIVE view and refetch when the filters/search/shard/table change. The
    // shared `useFacets` hook owns the slot transitions and toggle/refetch; only the
    // per-view query (`FACET_COLUMN` over the current shard/filters/search) is ours.
    const { clearFacets, facets, refetchFacets, toggleFacet: toggleFacetColumn } = useFacets();

    // Edit state: the row being edited (its id, or `""` for a new insert) and
    // the JSON-doc draft. `null` when no editor is open. `writeError` surfaces a
    // rejected write without disturbing the page-read error.
    const [editing, setEditing] = useState<null | { docText: string; id: null | string }>(null);
    const [writeError, setWriteError] = useState<null | string>(null);
    /** Rows the last bulk op wrote, so a drain that finishes doesn't finish silently. Cleared when the next one starts. */
    const [writeNotice, setWriteNotice] = useState<null | string>(null);

    /**
     * Where the last capped bulk drain stopped, so the operator's next identical
     * run resumes instead of rescanning. A ref, not state: nothing renders from it
     * and re-rendering on it would re-key the page query mid-drain.
     */
    const bulkResume = useRef<null | { after: string; key: string }>(null);

    // Inline-edit state: the staged-edit buffer, the cell currently open for
    // editing, and whether a batch commit is in flight. Edits accumulate in
    // `stagedEdits` (Outerbase-style) until committed or discarded.
    const stagedEdits = useStagedEdits();
    const [editingCell, setEditingCell] = useState<null | { column: string; rowId: string }>(null);
    const [committing, setCommitting] = useState<boolean>(false);

    // Tracks the (table, view) identity the local view state has last been
    // caught up to — either by a full re-seed, OR by simply catching up to the
    // URL mirror's own echo (see the `else if` below the reset block). Seeded
    // with the mount `tableParam`/incoming view so the first render is a no-op
    // (the `useState` initializers above already hydrated from the URL).
    // `seededViewKey` is a serialized snapshot of the fields a re-seed consumes
    // (shard/search/filters/order — see `serializeView`), so a same-table apply
    // (a saved query, or browser back/forward, that changes the view WITHOUT
    // changing the table) is visible even though `tableParam` alone isn't.
    //
    // MUST advance on every committed render whose incoming view is accounted
    // for — a re-seed OR an echo — never JUST a re-seed. It is also read by the
    // mirror effect's guard below, and if it only ever advanced inside the
    // reset block, the FIRST echo would permanently desync it from
    // `incomingViewKey` (the echo isn't a re-seed, so the reset block never
    // runs) — the guard would then block the mirror forever after that point,
    // and the next unrelated render would misread whatever the user had typed
    // SINCE as a fresh external apply, wrongly re-seeding and reverting it.
    const [seededTableParameter, setSeededTableParameter] = useState<string | undefined>(tableParam);
    const [seededViewKey, setSeededViewKey] = useState<string>(() => serializeView(initialShardKey, initialSearch, initialFilters, initialOrderBy));

    // Bumped on every re-seed (table switch OR same-table view apply) to re-key
    // both debounces below, so a re-seed's shard/search snap immediately instead
    // of trailing the OLD value for up to 300–400ms (see `filterInput`/
    // `shardInput` below).
    const [seedEpoch, setSeedEpoch] = useState<number>(0);

    // The view this component last EMITTED (or would emit) to the host — the
    // exact payload the mirror effect far below sends. Read here, at the TOP of
    // the function, to tell an incoming view apart from the mirror's own echo of
    // it — which is exactly why this is `useState`, not a ref: a value that
    // participates in a render-time branching decision (see `isSameTableViewApply`
    // below) has to be state so the read stays pure and the Compiler can reason
    // about it, even though nothing here renders it directly. Updated by a plain
    // effect (not `useMirroredRef`) because the value isn't computable until this
    // render's `search`/`debouncedShard` exist, further down — see that effect for
    // why. The lazy initializer keeps the mount-only `serializeView` call from
    // re-running (and being discarded) on every subsequent render.
    const [emittedViewKey, setEmittedViewKey] = useState<string>(() => serializeView(initialShardKey, initialSearch, initialFilters, initialOrderBy));

    const isTableSwitch = tableParam !== seededTableParameter;

    // The incoming view this render's props describe — compared against BOTH
    // `seededViewKey` (what the reset block below last locked in) and
    // `emittedViewKey` (what this component last mirrored to the host).
    // Needing BOTH to differ is what makes the URL round trip a fixed point,
    // without a second seeding mechanism:
    //
    //  - `seededViewKey` breaks the loop WITHIN one re-seed: React's "adjust
    //    state while rendering" pattern discards this render and retries
    //    synchronously once a setter below runs; on that retry `seededViewKey`
    //    already equals the incoming key (it's plain state, so the update is
    //    visible on the retry), so the condition goes false immediately.
    //    Without it, `emittedViewKey` — only updated by a COMMITTED render's
    //    effect, which the retry hasn't reached yet — would still read stale,
    //    and the retry would re-trigger itself forever.
    //  - `emittedViewKey` breaks the loop ACROSS renders: the user's own
    //    typing debounces into `search`/`debouncedShard`, the mirror effect
    //    below sends that to the host, and the host echoes it straight back as
    //    this same render's `initialSearch`/`initialShardKey`. By the time that
    //    echo arrives, the mirror's effect has already updated
    //    `emittedViewKey` to match it, so the echo reads as "already current"
    //    rather than as a fresh apply.
    //
    // Gated on `!isTableSwitch` because a real table switch already
    // unconditionally re-seeds below; this only covers the same-table case a
    // switch doesn't reach.
    const incomingViewKey = serializeView(initialShardKey, initialSearch, initialFilters, initialOrderBy);
    const isSameTableViewApply = !isTableSwitch && incomingViewKey !== seededViewKey && incomingViewKey !== emittedViewKey;
    const isReseed = isTableSwitch || isSameTableViewApply;

    // Re-seed the per-table local view state whenever the open table changes OR
    // (same table) a saved-query apply / browser back-forward hands this render a
    // genuinely new view — an in-app switch, an FK-nav, a deep link, a same-table
    // apply, or browser back/forward. The new values come from the new URL (empty
    // on a plain switch, the id on an FK-nav, the saved view on a deep link or
    // apply), so the table + view and the local state never disagree.
    //
    // Done RENDER-TIME (the "adjusting state when a prop changes" pattern), not in
    // an effect: an effect — even a synchronous one, even one that skips the old
    // `queueMicrotask` hop — always lets render N commit with the PREVIOUS table's
    // state before it can reset anything for render N+1, and a delete clicked in
    // that committed window reads the previous table's `debouncedShard`. Calling
    // these setters here makes React discard this render and retry synchronously
    // with the reset state already applied, so `pageArgs`/`countArgs` and
    // `debouncedShard` below are correct on the first render that ever commits
    // after a switch — no write-window where a click can still reach the old
    // table/shard.
    //
    // `selectedTable` is derived from `tableParam`, so there is no separate
    // reconcile/"select the URL's table" step — opening the URL's table is
    // implicit. Reads `initialFilters`/`initialOrderBy`/`initialSearch`/
    // `initialShardKey` DIRECTLY (this render's props), not through a mirrored
    // ref: this block is gated by a plain condition re-evaluated every render
    // (`isReseed`, above) rather than an effect dependency array, so it can only
    // ever fire when the table actually changed or the incoming view actually
    // differs from both what was seeded AND what was just emitted. The URL-mirror
    // round trip from the user's OWN typing (which changes `initialSearch` etc.
    // without changing `tableParam`) is exactly the case `emittedViewKey`
    // exists to recognize as "no-op" rather than "apply" — see the comment on
    // `isSameTableViewApply` above.
    if (isReseed) {
        setSeededTableParameter(tableParam);
        setSeededViewKey(incomingViewKey);
        setSeedEpoch((epoch) => epoch + 1);
        setSorting(fromOrderBy(initialOrderBy));
        setFilter(initialSearch ?? "");

        const nextFilters = toEditableFilters(initialFilters ?? []);

        setFilters(nextFilters);
        // Re-seed the shard from the new URL too, so a switch/apply that also
        // changes shard (a saved query / cross-shard deep link) points reads AND
        // writes at the URL's shard instead of leaving the previous shard live.
        setShardKey(initialShardKey ?? "");
        clearFacets();
        stagedEdits.clear();
        setEditingCell(null);
        setOffset(0);
        // Every bulk-op banner describes the view being left behind — "500 rows
        // written." over a different table reads as if it just happened — and a
        // parked resume cursor belongs to the old table/shard, where replaying it
        // against the new one would skip every row sorting below it.
        setWriteError(null);
        setWriteNotice(null);
        bulkResume.current = null;
    } else if (incomingViewKey !== seededViewKey) {
        // Not a re-seed (`isReseed` is false here, and `isReseed` is
        // `isTableSwitch || isSameTableViewApply` — so BOTH are false too: this
        // only reaches here when `incomingViewKey === emittedViewKey`), but
        // `incomingViewKey` still differs from `seededViewKey` — the URL
        // mirror's own echo of what THIS component last emitted, arriving back
        // as this render's `initialSearch`/`initialShardKey`/etc.
        //
        // `seededViewKey` MUST still advance here, even though nothing else
        // does: it is also read by the mirror effect's guard below
        // (`seededViewKey !== incomingViewKey`), which exists to skip a stale
        // mirror write while a re-seed is in flight. Leaving `seededViewKey`
        // frozen at its last RESEED value (rather than catching it up to every
        // harmless echo too) would permanently desync it from `incomingViewKey`
        // after the FIRST echo — the mirror guard would then block every future
        // commit, and the next render whose `emittedViewKey` has moved on
        // further (from a SECOND, later keystroke) would misread the still-stale
        // `incomingViewKey` as a fresh external apply and wrongly re-seed,
        // reverting the second change and wiping staged edits/offset/facets with
        // it. Advancing it here — without touching any other state — keeps the
        // invariant the mirror guard depends on actually true.
        setSeededViewKey(incomingViewKey);
    }

    // The raw input each debounced mirror below reflects for THIS render: on a
    // re-seed (table switch OR same-table view apply), the new view's URL values
    // directly — the `filter`/`shardKey` STATE above only catches up once React
    // retries this render, and feeding `useDebounced` the stale state on THIS
    // pass would bake the stale value into its own internal (persistent)
    // `debounced` state via its `resetKey` snap (see `useDebounced`'s doc
    // comment). Otherwise, the live state as usual.
    const filterInput = isReseed ? (initialSearch ?? "") : filter;
    const shardInput = isReseed ? (initialShardKey ?? "") : shardKey;

    // Search box value, debounced into a server-side `search` (filters across the
    // WHOLE table, not just the loaded page), which re-fetches from offset 0.
    //
    // The shard the reads target, debounced so typing a key settles before
    // refetching the table list + page rather than firing per keystroke. Page-bound
    // actions (preview, facet fetch, row write/delete, bulk delete) target this same
    // settled shard so a write can never hit a different shard than the one whose
    // rows are on screen during the debounce window. The live `shardKey` is only the
    // input value + the share-link descriptor.
    //
    // Both key their `resetKey` on `tableParam` + `seedEpoch`: a re-seed (table
    // switch OR same-table apply) snaps them straight to the new view's values
    // (via `filterInput`/`shardInput` above) with NO trailing debounce window,
    // instead of continuing to serve the previous view's search predicate / shard
    // for up to 300–400ms after the switch/apply.
    const debounceResetKey = `${tableParam ?? ""}:${seedEpoch.toString()}`;
    const search = useDebounced(filterInput.trim(), 300, debounceResetKey);
    const debouncedShard = useDebounced(shardInput.trim(), 400, debounceResetKey);

    // Mirror the emitted view — the exact payload the mirror effect far below
    // sends to the host — into `emittedViewKey`, so the render-time re-seed
    // check above can compare against it next render. This is the same
    // "adjust state while rendering" idiom as the `isReseed` block above (a
    // direct, conditional `setEmittedViewKey` call in the render body, not
    // inside `useEffect`) rather than a mirrored ref: it can't just BE a
    // `useMirroredRef`/effect up there, since the value depends on
    // `search`/`debouncedShard`/`filters`/`sorting`, none of which exist yet at
    // that point in the function — and a ref would have to be READ during
    // render too (in the `isSameTableViewApply` comparison), which is the
    // access-refs-during-render pattern this hook deliberately avoids. When the
    // computed value differs, calling the setter here discards this render and
    // retries synchronously with the new value already in place — exactly once,
    // since the retry recomputes the identical string from the same
    // `search`/`debouncedShard`/`filters`/`sorting` and the comparison then
    // holds.
    const nextEmittedViewKey = serializeView(debouncedShard, search, toFilterClauses(filters), toOrderBy(sorting));

    if (nextEmittedViewKey !== emittedViewKey) {
        setEmittedViewKey(nextEmittedViewKey);
    }

    // ── Reads via TanStack Query: a one-shot fetch plus a live WS push into the
    // cache (the same model as every other studio panel). The table list follows
    // the debounced shard; the page read's args ARE the view, so selecting a table
    // or paginating / searching / filtering / sorting transparently refetches.
    const tablesQuery = useAdminQuery<TableInfo[]>(ADMIN_FUNCTIONS.listTables, NO_ARGS, { live: true, shardKey: debouncedShard });
    const tables = tablesQuery.data ?? null;
    const tablesError = tablesQuery.error;

    const pageArgs = toPageArgs({ filters, offset, pageSize, search, sorting, table: selectedTable ?? "" });

    // The row count, split off the page read and keyed on the PREDICATE alone
    // (table / filters / search) — no `offset`, `pageSize`, or `orderBy`, since a
    // COUNT is unaffected by paging or ordering. Paging (an offset-only change)
    // therefore leaves this key untouched, so it reuses the cached total instead
    // of re-running the COUNT per page. A predicate change (table / filters /
    // search) re-keys it → a fresh count; a live write into a matching row re-runs
    // it on the same key (it shares the page read's table dependency), so the
    // displayed total stays correct. `limit: 1` keeps the (ignored) row fetch
    // minimal — only `.total` is read.
    const countArgs = toCountArgs({ filters, search, table: selectedTable ?? "" });

    // `keepPreviousData` is off: the placeholder isn't identity-aware, so holding
    // the last page across a `selectedTable` / `debouncedShard` change would render
    // the prior table's/shard's rows while edits and deletes already target the new
    // one. `live` streams writes in. Disabled until a table is open.
    const pageQuery = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, pageArgs, {
        enabled: selectedTable !== null,
        keepPreviousData: false,
        live: true,
        shardKey: debouncedShard,
    });
    const page = pageQuery.data ?? null;
    const pageError = pageQuery.error;
    const { liveError } = pageQuery;

    // Live count on the predicate key. Same table dependency as the page read, so
    // a write pushes a re-run and the total updates; paging doesn't touch its key.
    const countQuery = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, countArgs, {
        enabled: selectedTable !== null,
        live: true,
        shardKey: debouncedShard,
    });

    // Record the browsed shard into recent-shards history once its tables resolve.
    useEffect(() => {
        if (tablesQuery.data !== undefined) {
            recordShard(debouncedShard);
        }
    }, [tablesQuery.data, debouncedShard]);

    // Select a table = navigate the URL to it (the host drops the previous
    // filters/sort/search so the new table opens clean). The selection itself is
    // derived from the URL, and the per-table local view state is re-seeded by the
    // `tableParam`-change effect below — so this is just the navigation.
    const selectTable = (table: string): void => {
        onSelectTable?.(table);
    };

    // Follow a foreign-key cell: navigate to the target table with the referenced
    // id pre-filled as the search, so an operator can traverse relations by
    // clicking. Like `selectTable`, this only navigates — the re-seed effect picks
    // the `search` up from the new URL.
    const navigateToRef = (targetTable: string, id: string): void => {
        onSelectTable?.(targetTable, { search: id });
    };

    // One-shot read of the row a foreign-key cell points at, for the hover preview,
    // without disturbing the current view. `search` is a substring match across all
    // columns (not an exact PK lookup), so it can surface rows that merely *contain*
    // the id in some other column — fetch a small candidate window and return the row
    // whose primary key actually equals the id, or null when none does. Best-effort:
    // a cross-tier (`.global()`) target or a failed read also resolves to null.
    const previewRef = async (targetTable: string, id: string): Promise<Record<string, unknown> | null> => {
        try {
            const result = (await client.query(
                READ_TABLE_PAGE,
                { filters: [], limit: PREVIEW_CANDIDATES, offset: 0, search: id, table: targetTable },
                callOptions(debouncedShard),
            )) as TablePage;

            return result.rows.find((row) => rowId(row) === id) ?? null;
        } catch {
            return null;
        }
    };

    // ── Facets (Datasette-style per-column value/count summaries) ───────────
    // The per-view fetcher the shared hook drives: one `FACET_COLUMN` query over the
    // given shard/filters/search. `FacetResult` is the on-the-wire summary shape.
    const facetFetcher =
        (shard: string, table: string, activeFilters: EditableFilter[], searchQuery: string): FacetFetcher =>
        (column) =>
            client.query(
                FACET_COLUMN,
                { column, filters: toFilterClauses(activeFilters), search: searchQuery, table },
                callOptions(shard),
            ) as Promise<FacetResult>;

    // Toggle a column into / out of the facet sidebar. Turning it on seeds a
    // loading slot and fetches its summary for the current view; turning it off
    // drops it entirely. With no table selected the hook seeds the slot without
    // fetching (a null fetcher).
    const toggleFacet = (column: string): void => {
        toggleFacetColumn(column, selectedTable === null ? null : facetFetcher(debouncedShard, selectedTable, filters, search));
    };

    // Clicking a facet value adds an `eq` filter for that column/value, narrowing
    // the view to those rows. Reuses the same `EditableFilter` machinery as the
    // filter bar (its value is a string until coerced on the wire). Replaces any
    // existing clause for the same column so repeated clicks don't stack.
    const facetFilter = (column: string, value: unknown): void => {
        const text = facetValueText(value);

        setFilters((current) => [...current.filter((clause) => clause.column !== column), { column, operator: "eq", value: text }]);
        setOffset(0);
    };

    // `facetFetcher` / `refetchFacets` and `onViewChange` are read through refs so
    // the two effects below can depend on the *view values* alone. Those callbacks'
    // identities churn every render (recreated unless React Compiler memoizes them);
    // listing them in the deps made the effects re-fire on every render — wasted
    // facet refetches and, worse, a self-perpetuating `onViewChange` → `navigate`
    // loop that re-asserts `/data` and traps the user on the tab. Keying on the
    // values means each fires only when the displayed view actually changes.
    const facetFetcherRef = useMirroredRef(facetFetcher);
    const refetchFacetsRef = useMirroredRef(refetchFacets);
    const onViewChangeRef = useMirroredRef(onViewChange);

    // Refetch every toggled-on facet when the active view (filters / search / shard
    // / table) changes, so the summaries always reflect the previewed rows. The
    // shard / search are already debounced, so this tracks the displayed view; it's
    // gated on a selected table so it doesn't fire before one is open.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- the facet summaries are derived from the active view (a value, not a discrete event); refetching them when it changes is the correct pattern.
        if (selectedTable === null) {
            return;
        }

        // `refetchFacets` re-runs only the already-open facets (read off the hook's
        // ref); toggling a single facet on is handled by `toggleFacet`'s own fetch.
        refetchFacetsRef.current(facetFetcherRef.current(debouncedShard, selectedTable, filters, search));
        // Fire on the active view; the facet callbacks are read via refs (see above).
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the refs are `useMirroredRef` handles — stable by construction, and reading them is the whole point: the effect keys on the VIEW values so it fires when the view changes, not when a callback identity churns
        // eslint-disable-next-line react-hooks/exhaustive-deps -- same reason: `useMirroredRef` handles are stable, and listing them would say this effect depends on identities it deliberately does not
    }, [debouncedShard, selectedTable, filters, search]);

    // Mirror the active view (shard / search / filters / sort) to the host so it can
    // write it into the URL — making every view a real, shareable link. The shard /
    // search are debounced, so it tracks the displayed view; the table itself is
    // mirrored separately by `onSelectTable`.
    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- the URL is a projection of the active view (a value, not a discrete event); mirroring it when the view changes is the correct pattern. */
        if (selectedTable === null || onViewChangeRef.current === undefined || seededTableParameter !== tableParam || seededViewKey !== incomingViewKey) {
            /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
            // The render-time reset above keeps `seededTableParameter`/`seededViewKey`
            // in lockstep with `tableParam`/the incoming view on every COMMITTED
            // render, so this branch is a defensive invariant rather than a live gate
            // now (there's no longer a committed render where a re-seed has landed but
            // the reset hasn't) — kept so a future change to the reset can't silently
            // reintroduce the stale-URL-write hazard the two-effect version had to
            // route around.
            return;
        }

        onViewChangeRef.current({
            filters: toFilterClauses(filters),
            orderBy: toOrderBy(sorting),
            search,
            shard: debouncedShard,
        });
        // Fire on the displayed view; `onViewChange` is read via `onViewChangeRef` (see above).
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the ref is a `useMirroredRef` handle — stable by construction; depending on `onViewChange` itself is what caused the navigate loop this pattern exists to avoid
        // eslint-disable-next-line react-hooks/exhaustive-deps -- same reason: the ref handle is stable, and depending on `onViewChange` is exactly the loop this avoids
    }, [selectedTable, tableParam, seededTableParameter, seededViewKey, incomingViewKey, filters, sorting, search, debouncedShard]);

    const goToPage = (nextOffset: number): void => {
        if (selectedTable === null) {
            return;
        }

        setOffset(Math.max(0, nextOffset));
    };

    // ── Inline cell editing → staged buffer → preview-diff → commit ──────────
    const startCellEdit = (targetRow: string, column: string): void => {
        setEditingCell({ column, rowId: targetRow });
    };

    const cancelCellEdit = (): void => {
        setEditingCell(null);
    };

    // Commit every staged cell edit as a per-row patch (the writer merges the
    // changed fields into the existing doc), then reload the page. Sequential so
    // a failure pins the offending row.
    //
    // Each row leaves the buffer as ITS OWN patch lands, never all of them after
    // the loop: the writer commits per row, so a failure on row k had already
    // written rows 1..k-1 — clearing at the end never ran, and the panel went on
    // showing an old→new diff for changes that were already on disk. The refetch
    // runs on both paths for the same reason.
    const commitStaged = async (): Promise<void> => {
        if (selectedTable === null) {
            return;
        }

        setWriteError(null);
        setCommitting(true);

        try {
            for (const [id, columns] of Object.entries(stagedEdits.staged)) {
                // eslint-disable-next-line no-await-in-loop -- one patch per edited row; sequential so a failure pins the offending row
                (await client.query(WRITE_ROW, { doc: columns, id, op: "patch", table: selectedTable }, callOptions(debouncedShard))) as WriteRowResult;
                // `columns` is what this patch actually wrote — pass it so a cell
                // the operator restaged while the write was in flight survives.
                stagedEdits.drop(id, columns);
            }
        } catch (error) {
            setWriteError((error as Error).message);
        }

        setEditingCell(null);
        pageQuery.refetch();
        setCommitting(false);
    };

    const discardStaged = (): void => {
        stagedEdits.clear();
        setEditingCell(null);
    };

    // Resolve the staged buffer against the loaded page for the old→new diff.
    const stagedChanges = resolveStagedChanges(page, stagedEdits.staged);

    // Search / filters / sort / page-size changes flow straight into `pageArgs`, so
    // the page query refetches on its own. Each input's handler resets offset to the
    // first page when it narrows the view (`onFilterChange`, `changeFilters`,
    // `facetFilter`, `changeSorting`, `changePageSize`, `selectTable`,
    // `navigateToRef`) — no manual refetch effects are needed (this is what the
    // React Query migration removes).

    // Issue a writeRow op then reload the current page so the change shows. A
    // delete passes no doc; insert (id === "") / patch carry the JSON draft.
    const writeRow = async (op: "delete" | "insert" | "patch", id: null | string, documentText?: string): Promise<void> => {
        if (selectedTable === null) {
            return;
        }

        setWriteError(null);

        let parsedDocument: Record<string, unknown> | undefined;

        if (op !== "delete") {
            let raw: unknown;

            try {
                raw = documentText === undefined || documentText.trim() === "" ? {} : JSON.parse(documentText);
            } catch (error) {
                setWriteError(`Invalid JSON: ${(error as Error).message}`);

                return;
            }

            try {
                // The editor's text is the ENCODED document (see `onRowEdit`), so
                // decode before sending: a `v.bigint()` field goes back over the
                // wire as a real bigint the writer's validator accepts, instead
                // of the tagged array it would otherwise reject. No-op for the
                // plain-JSON documents every other table has.
                //
                // Separate from the parse above so a malformed TAG — which is
                // well-formed JSON — isn't reported as a syntax error.
                const decoded = decodeWire(raw);

                // The editor is free text, so it can hold valid JSON that is not
                // a document: `[1, 2]`, or a root-level tag that decodes to a
                // Date/bytes. Sending one would have the writer persist junk
                // fields rather than reject it.
                if (!isPlainObject(decoded)) {
                    setWriteError("The document must be a JSON object.");

                    return;
                }

                parsedDocument = decoded;
            } catch (error) {
                setWriteError(`Invalid document: ${(error as Error).message}`);

                return;
            }
        }

        try {
            (await client.query(
                WRITE_ROW,
                { doc: parsedDocument, id: id ?? undefined, op, table: selectedTable },
                callOptions(debouncedShard),
            )) as WriteRowResult;
            setEditing(null);
            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        }
    };

    // Drain a bounded server bulk op (`deleteRows`, `clearTable`, `patchRows`) by
    // looping a single round-trip while it reports `hasMore` — never per-row. The
    // server writes each matching row THROUGH the schema-aware writer (so FTS /
    // aggregate / rank shadow tables stay in sync), capped per call; the loop is
    // bounded by `MAX_BULK_BATCHES` so it can never run unbounded. Sequential by
    // design, so the round-trips can't be parallelised.
    //
    // Running out of batches before the server reports `hasMore: false` means rows
    // still match the predicate — the loop just stopped asking. Finishing silently
    // would look like success (the visible page shrinks along with whatever DID get
    // written) while leaving the operator with no signal that more rows are out
    // there, so a truncation notice goes on `writeError`.
    //
    // `resume` is what makes "run it again" true for a PATCH. A delete drains on a
    // re-run whether or not it resumes — the rows it removed no longer match — but a
    // patch that leaves rows matching would rescan from the top, rewrite the same
    // first `MAX_BULK_BATCHES × 500` rows, and hit the cap again forever. So the
    // cursor the server hands back on a cap-hit is parked here, keyed by the exact
    // request, and the next identical run picks up where this one stopped.
    const drainBulk = async (reference: FunctionReference, args: Record<string, unknown>, spec: BulkDrainSpec): Promise<number> => {
        if (selectedTable === null) {
            return 0;
        }

        setWriteError(null);
        setWriteNotice(null);

        // A resumable op ALWAYS opens with a cursor — the one a previous capped run
        // of this EXACT request parked, otherwise `""`, which sorts below every real
        // id. A non-resumable one opens with none, which is what keeps its scan
        // unordered. `drainBulkOp` owns it from there; it never travels in `args`.
        const resumeKey = bulkResumeKey(reference, args, debouncedShard);
        const parked = bulkResume.current?.key === resumeKey ? bulkResume.current.after : undefined;
        const openCursor = spec.resumable ? (parked ?? "") : undefined;

        let written = 0;

        try {
            const drained = await drainBulkOp({
                args,
                maxBatches: MAX_BULK_BATCHES,
                openCursor,
                query: async (batchArgs) => (await client.query(reference, batchArgs, callOptions(debouncedShard))) as BulkRowOpResult,
            });

            written = drained.written;
            bulkResume.current = drained.cursor === undefined ? null : { after: drained.cursor, key: resumeKey };

            if (drained.outcome === "cap-hit") {
                setWriteError(spec.truncated);
            }

            setWriteNotice(`${written.toString()} ${written === 1 ? "row" : "rows"} ${spec.verb}.`);

            return written;
        } catch (error) {
            // A throw loses the failing batch's own committed count, so this is a
            // lower bound — hence "at least". The rows before the failure are already
            // on disk, so silence here would be the worse lie.
            setWriteError(`${(error as Error).message} (at least ${written.toString()} rows were already ${spec.verb})`);

            bulkResume.current = null;

            return written;
        } finally {
            // Also on the failure path: a partial batch is committed server-side, so
            // reporting an error over a grid still showing pre-write values is worse
            // than refreshing under the message.
            setOffset(0);
            pageQuery.refetch();
        }
    };

    // Server-side sort: a column-header click changes the order, so reset to the
    // first page (the operator expects the top of the newly-sorted results, not the
    // same offset reordered). Wraps `setSorting` for the grid; `selectTable` /
    // `navigateToRef` already reset offset themselves, so they keep the raw setter.
    const changeSorting: OnChangeFn<SortingState> = (updater): void => {
        setSorting(updater);
        setOffset(0);
    };

    // Headless table model + virtualizer for the loaded page. The page-local
    // `sorting` state stays here (table switches reset it via `setSorting`); the
    // hook owns only the derived react-table/virtualizer wiring.
    // Reverse relations are derived from schema metadata (see `back-relations.ts`)
    // and passed in as extra column defs; only the ones switched on are resolved.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: feeds the grid's `columnDefs`, and react-table resets column sizing and row selection whenever `columns` changes identity
    const activeBackRelations = useMemo(
        () => (selectedTable === null ? [] : (resolveBackRelations?.(selectedTable) ?? [])),
        [resolveBackRelations, selectedTable],
    );
    const table = useDataBrowserTable(page, sorting, changeSorting, activeBackRelations);

    // The currently-displayed view, for the "Copy link" / "Save query" affordances.
    // Derived from the live state (not the `loaded` descriptor) so it reflects the
    // bar as edited, even before a re-fetch lands. Uses the debounced `search` so a
    // half-typed query isn't captured mid-keystroke.
    const currentView = {
        filters: toFilterClauses(filters),
        orderBy: toOrderBy(sorting),
        search,
        shard: shardKey,
        table: selectedTable ?? undefined,
    };

    // Total comes from the predicate-keyed count query. While it first loads
    // (before its count lands) fall back to a lower bound from the current page —
    // `offset + rows shown` — so a page with rows never briefly reads "0 of 0".
    // The count resolves alongside the page on first load and stays cached across
    // paging, so this fallback is a brief first-load transient only.
    const total = countQuery.data?.total ?? (page === null ? 0 : offset + page.rows.length);
    const hasPrevious = offset > 0;

    // The predicate the bulk ops actually send — see `DataBrowserModel.hasPredicate`.
    // Measured through `toFilterClauses`, the same transform the request uses:
    // a filter row the operator has added but not yet given a column to is
    // DROPPED there, so counting raw `filters.length` offered "Delete N matching"
    // over the whole table and then sent `filters: []`, which the server refuses.
    const hasPredicate = search !== "" || toFilterClauses(filters).length > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const loadTables = (): void => {
        tablesQuery.refetch();
    };

    const showTable = (): void => {
        setViewMode("table");
    };

    const showJson = (): void => {
        setViewMode("json");
    };

    const bulkDelete = (): void => {
        fireAndForget(drainBulk(DELETE_ROWS, { filters: toFilterClauses(filters), search, table: selectedTable }, DELETE_DRAIN));
    };

    const emptyTable = (): void => {
        fireAndForget(drainBulk(CLEAR_TABLE, { table: selectedTable }, DELETE_DRAIN));
    };

    // Shallow-merge `doc` into every row matching the ACTIVE view — the same
    // predicate "delete matching" removes by, so the count the button shows is
    // the set that gets written. Routed through the writer server-side, which is
    // why this exists at all: the SQL console refuses a raw `UPDATE`.
    const bulkPatch = (document_: Record<string, unknown>): void => {
        fireAndForget(drainBulk(PATCH_ROWS, { doc: document_, filters: toFilterClauses(filters), search, table: selectedTable }, PATCH_DRAIN));
    };

    const onFilterChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.target.value);
        // A new search narrows the result set — jump back to the first page so the
        // current offset can't point past the (smaller) total.
        setOffset(0);
    };

    // Apply a structured-filter change and reset to the first page (same reason as
    // the search box). Exposed as `onFiltersChange`.
    const changeFilters = (next: EditableFilter[]): void => {
        setFilters(next);
        setOffset(0);
    };

    const addRow = (): void => {
        setWriteError(null);

        // Seed the insert form with the table's editable columns (blank values) so
        // the form has fields to fill — instead of an empty `{}` the user must type
        // into. Meta columns (id / _creationTime / __doc__) are server-managed.
        const seed: Record<string, unknown> = {};

        for (const column of page?.columns ?? []) {
            if (!META_COLUMNS.has(column)) {
                seed[column] = "";
            }
        }

        setEditing({ docText: JSON.stringify(seed, null, 2), id: "" });
    };

    const setEditorDocumentText = (text: string): void => {
        setEditing((current) => (current === null ? current : { docText: text, id: current.id }));
    };

    const saveEdit = (): void => {
        if (editing === null) {
            return;
        }

        fireAndForget(writeRow(editing.id === "" ? "insert" : "patch", editing.id === "" ? null : editing.id, editing.docText));
    };

    const cancelEdit = (): void => {
        setEditing(null);
        setWriteError(null);
    };

    const goPrevious = (): void => {
        goToPage(offset - pageSize);
    };

    const goNext = (): void => {
        goToPage(offset + pageSize);
    };

    // Jump to a 1-based page: translate to an offset at the current page size. The
    // footer clamps the input, but floor at 0 defensively.
    const jumpToPage = (targetPage: number): void => {
        goToPage(Math.max(0, (targetPage - 1) * pageSize));
    };

    // Change rows-per-page; the guarded effect above re-fetches the first page at
    // the new size.
    const changePageSize = (size: number): void => {
        setPageSize(size);
        setOffset(0);
    };

    const onRowEdit = (id: null | string, original: TableRow): void => {
        setWriteError(null);
        // Seed the JSON editor from the ENCODED document, not the decoded one.
        // The rows now carry real `bigint`/`ArrayBuffer` values (the display
        // decode above), and `JSON.stringify` throws outright on a bigint and
        // flattens an ArrayBuffer to `{}` — so a money row would either blow up
        // the editor or silently offer a lossy document to save back. Encoding
        // first shows the exact stored form, which `writeRow` decodes on the way
        // out, making an untouched save byte-identical. `encodeWire` is identity
        // for JSON-safe data, so an ordinary row's editor text is unchanged.
        setEditing({ docText: JSON.stringify(encodeWire(rowDocument(original)), null, 2), id });
    };

    const onRowDelete = (id: null | string): void => {
        fireAndForget(writeRow("delete", id));
    };

    // Delete an explicit set of selected row ids (the checkbox selection), each
    // through the schema-aware writer so FTS / aggregate / rank shadow tables stay
    // in sync, then reload the page. Sequential so a failure pins the offending
    // row; the selection is page-bounded (≤ pageSize), so this never fans out
    // unboundedly the way a predicate delete could.
    const deleteSelected = async (ids: ReadonlyArray<string>): Promise<void> => {
        if (selectedTable === null || ids.length === 0) {
            return;
        }

        setWriteError(null);

        try {
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- one delete per selected row; sequential so a failure pins the offending row
                (await client.query(WRITE_ROW, { id, op: "delete", table: selectedTable }, callOptions(debouncedShard))) as WriteRowResult;
            }

            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        }
    };

    const onBulkDeleteSelected = (ids: ReadonlyArray<string>): void => {
        fireAndForget(deleteSelected(ids));
    };

    const onCommitStaged = (): void => {
        fireAndForget(commitStaged());
    };

    return {
        addRow,
        bulkDelete,
        bulkPatch,
        cancelCellEdit,
        cancelEdit,
        changePageSize,
        clearTable: emptyTable,
        columns: page?.columns ?? [],
        committing,
        currentView,
        discardStaged,
        editableColumn,
        editing,
        editingCell,
        facetFilter,
        facets,
        filter,
        filters,
        goNext,
        goPrevious,
        hasNext,
        hasPredicate,
        hasPrevious,
        jumpToPage,
        liveError,
        loadTables,
        navigateToRef,
        onBulkDeleteSelected,
        onCommitStaged,
        onFilterChange,
        onFiltersChange: changeFilters,
        onRowDelete,
        onRowEdit,
        page,
        previewRef,
        pageError,
        pageSize,
        rangeEnd,
        rangeStart,
        queryShardKey: debouncedShard,
        saveEdit,
        selectedTable,
        selectTable,
        setEditorDocumentText,
        setShardKey,
        shardKey,
        showJson,
        showTable,
        stage: stagedEdits.stage,
        stagedChanges,
        stagedValue: stagedEdits.stagedValue,
        startCellEdit,
        table,
        tables,
        tablesError,
        toggleFacet,
        total,
        viewMode,
        writeError,
        writeNotice,
    };
};

/**
 * All non-render state and handlers for the data browser: the admin RPC reads
 * (`listTables` / `readTablePage`), the live subscriptions, the schema-aware
 * writes, page-local sorting/search, and the derived pagination range. Composes
 * {@link useDataBrowserTable} for the headless table model. Extracted verbatim
 * from the component so behavior, fetch sequencing, and effect dependencies are
 * unchanged — the component is now just markup wiring.
 */
export type { DataBrowserModel };
export type { FacetState } from "./use-facets";
export { useDataBrowser };
