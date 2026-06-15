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

const VALID_OPERATORS = new Set<FilterOperator>(["contains", "eq", "gt", "gte", "lt", "lte", "ne"]);

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
 * Reconstruct a {@link DataView} from the router's search params. The inverse of
 * {@link dataViewToSearch}. Unknown/garbage params are dropped, never thrown on,
 * so a hand-edited or legacy link still hydrates into a sensible view.
 */
export const searchToDataView = (search: Record<string, unknown>): DataView => {
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
