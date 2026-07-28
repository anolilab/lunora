import type { FilterClause, FilterOperator } from "./admin";
import type { DataView } from "./saved-queries";

/**
 * The data browser's view state lives in the URL search params so every view is a
 * real, shareable link (Datasette's "every query is a URL"). This module is the
 * single round-tripping point between a {@link DataView} and the loosely-typed
 * record that TanStack Router's `useSearch`/`navigate` carries.
 *
 * The existing `?schema=` (tier) and `?table=` contract is preserved verbatim; the
 * extra view state rides alongside as `?shard=` (the shard key, omitted for the
 * root shard so the URL stays clean), `?search=` (the substring search, omitted
 * when empty), `?order=` (the sort, as `column:asc` / `column:desc`, omitted when
 * unsorted), and `?filters=` (a JSON-encoded clause array, omitted when there are
 * none). `schema` is omitted for the default shard tier (mirroring `table-editor`).
 */

/**
 * The data browser's URL search params, as TanStack Router carries them — the
 * validated wire shape produced by {@link validateDataViewSearch} (the route's
 * `validateSearch`). All values are the raw URL strings (`filters` is JSON,
 * `order` is `column:asc|desc`); {@link searchToDataView} parses them into a
 * structured {@link DataView}. Typing the route's search here replaces the
 * untyped `useSearch({ strict: false })` reads scattered through the data feature.
 *
 * Declared locally and exported at the end of the file (`import/exports-last`);
 * interfaces are hoisted, so the functions below reference it freely.
 */
interface DataViewSearch {
    /** JSON-encoded {@link FilterClause}[] (validated to parse into ≥1 clause). */
    filters?: string;

    /** Sort as `column:asc` / `column:desc` (validated against that grammar). */
    order?: string;

    /**
     * Comma-separated pinned column names. In the URL as well as browser storage
     * because a link to a wide table is only useful if it arrives with the same
     * columns frozen — the storage copy is the per-browser default, the URL wins
     * when present.
     */
    pins?: string;
    /** Storage tier; only `"global"` is carried (the shard default is omitted). */
    schema?: "global";
    /** Substring search across all columns. */
    search?: string;
    /** Shard key the view targets (omitted for the root shard). */
    shard?: string;
    /** The open table. */
    table?: string;
}

const VALID_OPERATORS = new Set<FilterOperator>(["contains", "eq", "gt", "gte", "lt", "lte", "ne"]);

/**
 * Read a non-blank string off the raw search record, else `undefined`. Trims so a
 * whitespace-only value (e.g. `?table=%20%20`) is rejected here at the router
 * boundary rather than flowing downstream as a real table name.
 */
const stringParameter = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") {
        return undefined;
    }

    const value = raw.trim();

    return value === "" ? undefined : value;
};

/** Narrow an unknown parsed entry to a {@link FilterClause}, dropping anything malformed. */
const isFilterClause = (entry: unknown): entry is FilterClause => {
    if (entry === null || typeof entry !== "object") {
        return false;
    }

    const candidate = entry as { column?: unknown; operator?: unknown };

    return typeof candidate.column === "string" && typeof candidate.operator === "string" && VALID_OPERATORS.has(candidate.operator as FilterOperator);
};

/** Read the structured filters out of a `?filters=&lt;json>` param, tolerating absence/garbage. */
const parseFilters = (raw: unknown): FilterClause[] => {
    if (typeof raw !== "string" || raw === "") {
        return [];
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        return Array.isArray(parsed) ? parsed.filter(isFilterClause) : [];
    } catch {
        return [];
    }
};

/** Read the `?order=&lt;column>:&lt;asc|desc>` param into an `orderBy`, or `undefined` when absent/malformed. */
const parseOrder = (raw: unknown): DataView["orderBy"] => {
    if (typeof raw !== "string" || raw === "") {
        return undefined;
    }

    const separator = raw.lastIndexOf(":");

    if (separator <= 0) {
        return undefined;
    }

    const column = raw.slice(0, separator);
    const direction = raw.slice(separator + 1);

    if (direction !== "asc" && direction !== "desc") {
        return undefined;
    }

    return { column, direction };
};

/**
 * Search params for the `/migrations` route: which recorded schema version's
 * diff is open. Validated at the router boundary like {@link DataViewSearch} so
 * the panel reads a trustworthy value instead of a raw record — a hash that is
 * not a plausible content hash is dropped rather than passed through to an RPC.
 */
interface SchemaVersionSearch {
    /** Content hash of the selected schema version. */
    version?: string;
}

/** A snapshot content hash: the 16 lowercase hex chars `hashSchemaSnapshot` produces. */
const SNAPSHOT_HASH_RE = /^[\da-f]{16}$/u;

/**
 * The `/data` route's `validateSearch`: normalise the raw router search into the
 * typed {@link DataViewSearch} at the router boundary, dropping anything
 * malformed (a non-`global` `schema`, an `order` that isn't `column:asc|desc`,
 * `filters` that don't parse into at least one valid clause, empty strings, and
 * any unknown params). Validating once here — rather than defensively in every
 * reader — means `useSearch` returns a trustworthy, typed shape, and a
 * hand-edited or legacy link is sanitised on navigation instead of flowing
 * garbage downstream. The URL string format is preserved verbatim (valid values
 * pass through untouched), so shared links and saved queries stay compatible.
 */
export const validateDataViewSearch = (search: Record<string, unknown>): DataViewSearch => {
    const validated: DataViewSearch = {};

    // Column names, comma-separated. Capped and shape-checked so a hand-edited
    // link can't push an unbounded string into persisted UI state.
    if (typeof search["pins"] === "string" && search["pins"] !== "") {
        const pins = search["pins"]
            .split(",")
            .filter((name) => name !== "" && name.length <= 64)
            .slice(0, 12);

        if (pins.length > 0) {
            validated.pins = pins.join(",");
        }
    }

    if (search["schema"] === "global") {
        validated.schema = "global";
    }

    const table = stringParameter(search["table"]);

    if (table !== undefined) {
        validated.table = table;
    }

    const shard = stringParameter(search["shard"]);

    if (shard !== undefined) {
        validated.shard = shard;
    }

    const searchText = stringParameter(search["search"]);

    if (searchText !== undefined) {
        validated.search = searchText;
    }

    // Keep `order` only when it matches the `column:asc|desc` grammar.
    const order = stringParameter(search["order"]);

    if (order !== undefined && parseOrder(order) !== undefined) {
        validated.order = order;
    }

    // Keep `filters` only when the JSON parses into at least one valid clause.
    const filters = stringParameter(search["filters"]);

    if (filters !== undefined && parseFilters(filters).length > 0) {
        validated.filters = filters;
    }

    return validated;
};

/**
 * Reconstruct a {@link DataView} from the router's search params. The inverse of
 * {@link dataViewToSearch}. Unknown/garbage params are dropped, never thrown on,
 * so a hand-edited or legacy link still hydrates into a sensible view.
 */
export const searchToDataView = (search: DataViewSearch | Record<string, unknown>): DataView => {
    const filters = parseFilters(search["filters"]);
    const orderBy = parseOrder(search["order"]);

    return {
        filters: filters.length > 0 ? filters : undefined,
        orderBy,
        search: typeof search["search"] === "string" && search["search"] !== "" ? search["search"] : undefined,
        shard: typeof search["shard"] === "string" && search["shard"] !== "" ? search["shard"] : undefined,
        table: typeof search["table"] === "string" && search["table"] !== "" ? search["table"] : undefined,
        tier: search["schema"] === "global" ? "global" : "shard",
    };
};

/**
 * Project a {@link DataView} onto a search-param patch. Returns every param the
 * view controls — present when meaningful, `undefined` to clear when not — so a
 * caller can spread it over the current params (`{ ...previous, ...patch }`) and
 * have stale params dropped. Defaults (`shard` tier, empty shard/search, no
 * filters/order) serialize to `undefined` so the URL stays clean.
 */
export const dataViewToSearch = (view: DataView): Record<string, string | undefined> => {
    const filters = view.filters ?? [];

    return {
        filters: filters.length > 0 ? JSON.stringify(filters) : undefined,
        order: view.orderBy === undefined ? undefined : `${view.orderBy.column}:${view.orderBy.direction}`,
        schema: view.tier === "global" ? "global" : undefined,
        search: view.search !== undefined && view.search !== "" ? view.search : undefined,
        shard: view.shard !== undefined && view.shard !== "" ? view.shard : undefined,
        table: view.table !== undefined && view.table !== "" ? view.table : undefined,
    };
};

/** Validate/normalise the `/migrations` route's search params. */
export const validateSchemaVersionSearch = (search: Record<string, unknown>): SchemaVersionSearch => {
    const { version } = search;

    return typeof version === "string" && SNAPSHOT_HASH_RE.test(version) ? { version } : {};
};

export type { DataViewSearch, SchemaVersionSearch };
