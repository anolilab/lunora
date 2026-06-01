/**
 * Pure `orderBy` + keyset-cursor helpers shared by both ORM dialects.
 *
 * The query layer compiles `where` through {@link compileWhere}; this module
 * owns the two remaining pure pieces:
 *
 *  - `orderBy` → a deterministic `ORDER BY` clause with a stable `id`
 *    tiebreak, so pagination has a total order to seek against.
 *  - keyset cursors — `encodeCursor`/`decodeCursor` round-trip the last
 *    row's sort key, and `buildSeekWhere` turns that key into a `where` tree
 *    that selects the rows strictly *after* the cursor. Keyset (not offset)
 *    pagination stays O(page) and is stable under concurrent inserts.
 *
 * Everything here is I/O-free and dialect-agnostic: SQL references are
 * produced by an injected {@link FieldRef}, and the seek predicate is emitted
 * as a {@link WhereInput} so the shared compiler renders it per dialect.
 */
import type { WithInput } from "./relations.js";
import type { FieldRef, WhereInput } from "./where-clause-compiler.js";

export type SortDirection = "asc" | "desc";

/** A single `{ field: "asc" | "desc" }` entry; `orderBy` is an ordered list of these. */
export type OrderByInput = Record<string, SortDirection>;

export interface QueryArgs {
    /**
     * Predicate injected by the runtime (e.g. by `@cirrus/server`'s RLS
     * middleware, §3.2). AND-merged into `where` before compilation so the
     * policy is enforced at the SQL layer regardless of caller input. This is
     * an internal seam; user-facing call sites should pass `where`, not
     * `baseWhere`. Public on the option type so cross-package consumers
     * (RLS in `@cirrus/server`, aggregates in §3.1) can populate it without
     * a server-only import.
     */
    baseWhere?: WhereInput;
    cursor?: null | string;
    limit?: number;
    orderBy?: OrderByInput[];
    /**
     * When `true`, `count()` invocations on the same table are rejected with
     * `CirrusError("COUNT_RLS_UNSUPPORTED")`. Set alongside `baseWhere` by RLS
     * to mirror kitcn's documented constraint that count is unsupported in an
     * RLS-restricted context. The `baseWhere` itself still applies to row
     * reads (`findMany`/`findFirst`) — this flag specifically guards `count`.
     */
    restrictsCounts?: boolean;
    where?: WhereInput;
    with?: WithInput;
}

export interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Array<Record<string, unknown>>;
}

export interface OrderKey {
    direction: SortDirection;
    field: string;
}

/** The implicit tiebreak appended to every sort so the order is total. */
const TIEBREAK_FIELD = "id";

const ID_FIELDS = new Set(["_id", "id"]);

/**
 * Flatten the `{ field: dir }[]` authoring form into an ordered list of sort
 * keys. An absent or empty `orderBy` defaults to creation order, matching the
 * legacy reader.
 */
export const normalizeOrderKeys = (orderBy: OrderByInput[] | undefined): OrderKey[] => {
    const keys: OrderKey[] = [];

    for (const entry of orderBy ?? []) {
        for (const [field, direction] of Object.entries(entry)) {
            keys.push({ direction, field });
        }
    }

    if (keys.length === 0) {
        return [{ direction: "asc", field: "_creationTime" }];
    }

    return keys;
};

/**
 * Render `ORDER BY ...` (without the keyword) from sort keys, appending a
 * stable ascending `id` tiebreak unless the caller already sorts by id.
 */
export const compileOrderBy = (keys: OrderKey[], fieldRef: FieldRef): string => {
    const parts = keys.map((key) => `${fieldRef(key.field)} ${key.direction === "desc" ? "DESC" : "ASC"}`);

    if (!keys.some((key) => ID_FIELDS.has(key.field))) {
        parts.push(`${fieldRef(TIEBREAK_FIELD)} ASC`);
    }

    return parts.join(", ");
};

const toBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
};

const fromBase64 = (encoded: string): string => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    return new TextDecoder().decode(bytes);
};

/**
 * Encode the sort key of `doc` (the values of each `orderBy` field, then its
 * id) as an opaque base64 cursor. The id is always included so the seek has a
 * unique terminal column.
 */
export const encodeCursor = (doc: Record<string, unknown>, keys: OrderKey[]): string => {
    const values = keys.map((key) => doc[key.field]);

    values.push(doc["_id"]);

    return toBase64(JSON.stringify(values));
};

/** Decode a cursor back into its ordered sort-key values (orderBy fields, then id). */
export const decodeCursor = (cursor: string): unknown[] => {
    const decoded = JSON.parse(fromBase64(cursor)) as unknown;

    if (!Array.isArray(decoded)) {
        throw new TypeError("invalid cursor");
    }

    return decoded;
};

/**
 * Build the `where` tree that selects rows strictly after the cursor under the
 * given sort. For keys `[a ASC, b DESC]` (plus the id tiebreak) it expands to
 * the lexicographic seek `(a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND id > ?)`,
 * letting the shared compiler render it per dialect.
 */
export const buildSeekWhere = (keys: OrderKey[], cursorValues: unknown[]): WhereInput => {
    const columns: OrderKey[] = keys.some((key) => ID_FIELDS.has(key.field)) ? keys : [...keys, { direction: "asc", field: TIEBREAK_FIELD }];

    const branches: WhereInput[] = [];

    for (const [pivot, pivotColumn] of columns.entries()) {
        const conditions: WhereInput[] = [];

        for (const [prefix, prefixColumn] of columns.slice(0, pivot).entries()) {
            conditions.push({ [prefixColumn.field]: { eq: cursorValues[prefix] } });
        }

        const strictOperator = pivotColumn.direction === "desc" ? "lt" : "gt";

        conditions.push({ [pivotColumn.field]: { [strictOperator]: cursorValues[pivot] } });

        // Wrap multi-condition branches so each disjunct is explicitly grouped
        // rather than leaning on SQL's AND-over-OR precedence.
        const [first] = conditions;

        branches.push(conditions.length === 1 && first !== undefined ? first : { AND: conditions });
    }

    return { OR: branches };
};
