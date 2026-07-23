/**
 * Pure `orderBy` + keyset-cursor helpers shared by both ORM dialects.
 *
 * The query layer compiles `where` through `compileWhereSql`; this module
 * owns the two remaining pure pieces:
 *
 * - `orderBy` → a deterministic `ORDER BY` clause with a stable `id`
 * tiebreak, so pagination has a total order to seek against.
 * - keyset cursors — `encodeCursor`/`decodeCursor` round-trip the last
 * row's sort key, and `buildSeekWhere` turns that key into a `where` tree
 * that selects the rows strictly *after* the cursor. Keyset (not offset)
 * pagination stays O(page) and is stable under concurrent inserts.
 *
 * Everything here is I/O-free and dialect-agnostic: the seek predicate is
 * emitted as a {@link WhereInput} so the shared drizzle compiler
 * (`compileWhereSql`) renders it per dialect.
 */
import { LunoraError } from "@lunora/errors";
import type { WhereInput } from "@lunora/shard-engine";

import type { WithInput } from "./relations";

type SortDirection = "asc" | "desc";

/** A single `{ field: "asc" | "desc" }` entry; `orderBy` is an ordered list of these. */
type OrderByInput = Record<string, SortDirection>;

interface QueryArgs {
    /**
     * Predicate injected by the runtime (e.g. by `@lunora/server`'s RLS
     * middleware, §3.2). AND-merged into `where` before compilation so the
     * policy is enforced at the SQL layer regardless of caller input. This is
     * an internal seam; user-facing call sites should pass `where`, not
     * `baseWhere`. Public on the option type so cross-package consumers
     * (RLS in `@lunora/server`, aggregates in §3.1) can populate it without
     * a server-only import.
     */
    baseWhere?: WhereInput;
    cursor?: null | string;

    /**
     * Opt a list read OUT of soft-delete scoping: when `true`, rows whose
     * soft-delete column is set are INCLUDED. Has no effect on a table without
     * `.softDelete()`. Default (absent/false) hides soft-deleted rows.
     */
    includeDeleted?: boolean;
    limit?: number;
    orderBy?: OrderByInput[];

    /**
     * Per-table read filter for relations loaded via `with`. Like `baseWhere`
     * but resolved by TARGET TABLE: when a `with` relation is fetched (or counted),
     * `resolveWith` AND-merges `relationBaseWhere(relation.table)` into that fetch,
     * and threads the provider into nested `with` levels. Set by `@lunora/server`'s
     * RLS middleware so a child table's read policy is enforced on the relation
     * hop too — without it, `findMany({ with: { child: true } })` would return the
     * child's rows unfiltered (RLS bypass). `undefined` ⇒ no per-relation filter.
     */
    relationBaseWhere?: (table: string) => undefined | WhereInput;

    /**
     * When `true`, `count()` invocations on the same table are rejected with
     * `LunoraError("COUNT_RLS_UNSUPPORTED")`. Set alongside `baseWhere` by RLS
     * to mirror kitcn's documented constraint that count is unsupported in an
     * RLS-restricted context. The `baseWhere` itself still applies to row
     * reads (`findMany`/`findFirst`) — this flag specifically guards `count`.
     */
    restrictsCounts?: boolean;

    /**
     * Project each returned row down to these fields. The system fields `_id` and
     * `_creationTime` are always retained (cursors + by-id reuse depend on them),
     * and any relations attached via `with` (their relation keys and `_count`)
     * survive the trim. Applied AFTER the rows are read and relations resolved, so
     * read-dependency tracking and cursor encoding see the full row — only the
     * payload returned to the caller is narrowed. Omit for the full document.
     */
    select?: ReadonlyArray<string>;
    where?: WhereInput;
    with?: WithInput;
}

interface QueryPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];

    /**
     * Reactive-pagination only: the cursor of the page's middle row, present on
     * a bounded `(start, end]` page so a client growing past its target size can
     * SPLIT it at this midpoint into two adjacent ranges without re-encoding
     * cursors itself. Omitted for legacy (open-ended) pages and for bounded
     * pages too small to split (< 2 rows).
     */
    splitCursor?: null | string;
}

interface OrderKey {
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
const normalizeOrderKeys = (orderBy: OrderByInput[] | undefined): OrderKey[] => {
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

const toBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

const fromBase64 = (encoded: string): string => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);

    return new TextDecoder().decode(bytes);
};

/**
 * Encode the sort key of `doc` (the values of each `orderBy` field, then its
 * id) as an opaque base64 cursor. The id is always included so the seek has a
 * unique terminal column.
 */
const encodeCursor = (record: Record<string, unknown>, keys: OrderKey[]): string => {
    const values = keys.map((key) => record[key.field]);

    values.push(record["_id"]);

    return toBase64(JSON.stringify(values));
};

/**
 * The cursor is client-supplied, so any decode failure is a bad request, not
 * a server fault. Returns a `LunoraError`-shaped error the runtime's error
 * mapper renders as a 400 (a raw `TypeError`/`SyntaxError` would fall through
 * to a generic 500).
 */
const invalidCursor = (): LunoraError => new LunoraError("BAD_REQUEST", "invalid cursor");

/** Decode a cursor back into its ordered sort-key values (orderBy fields, then id). */
const decodeCursor = (cursor: string): unknown[] => {
    let decoded: unknown;

    try {
        decoded = JSON.parse(fromBase64(cursor)) as unknown;
    } catch {
        // atob() throws InvalidCharacterError on non-base64 input and
        // JSON.parse throws SyntaxError on malformed JSON. Normalize both
        // client-supplied failures to the same typed 400 error.
        throw invalidCursor();
    }

    if (!Array.isArray(decoded)) {
        throw invalidCursor();
    }

    return decoded;
};

/**
 * Build the `where` tree that selects rows strictly after the cursor under the
 * given sort. For keys `[a ASC, b DESC]` (plus the id tiebreak) it expands to
 * the lexicographic seek `(a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND id > ?)`,
 * letting the shared compiler render it per dialect.
 */
const buildSeekWhere = (keys: OrderKey[], cursorValues: unknown[]): WhereInput => {
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

/**
 * The per-column comparator {@link buildSeekBeforeWhere} emits: every column
 * runs in the mirror direction of the strict seek (asc → `lt`, desc → `gt`),
 * except the final id tiebreak which is inclusive (`lte`/`gte`) so the boundary
 * row stays inside the page.
 */
const seekBeforeOperator = (direction: SortDirection, isFinal: boolean): string => {
    if (direction === "desc") {
        return isFinal ? "gte" : "gt";
    }

    return isFinal ? "lte" : "lt";
};

/**
 * Build the `where` tree that selects rows at-or-before the cursor under the
 * given sort — the inclusive upper bound that pairs with {@link buildSeekWhere}
 * to express a half-open page range `(start, end]`. For keys `[a ASC, b DESC]`
 * (plus the id tiebreak) it expands to the lexicographic seek
 * `(a lt ?) OR (a eq ? AND b gt ?) OR (a eq ? AND b eq ? AND id lte ?)`: the
 * strict direction is the mirror of {@link buildSeekWhere} on every column, and
 * the final id tiebreak is `lte` (inclusive) so the boundary row itself stays in
 * the page it terminates. Reactive pagination uses this for a page's fixed end
 * cursor; the shared compiler renders it per dialect.
 */
const buildSeekBeforeWhere = (keys: OrderKey[], cursorValues: unknown[]): WhereInput => {
    const columns: OrderKey[] = keys.some((key) => ID_FIELDS.has(key.field)) ? keys : [...keys, { direction: "asc", field: TIEBREAK_FIELD }];

    const branches: WhereInput[] = [];

    for (const [pivot, pivotColumn] of columns.entries()) {
        const conditions: WhereInput[] = [];

        for (const [prefix, prefixColumn] of columns.slice(0, pivot).entries()) {
            conditions.push({ [prefixColumn.field]: { eq: cursorValues[prefix] } });
        }

        const isFinal = pivot === columns.length - 1;
        // The terminal id tiebreak is inclusive (`lte`/`gte`) so the boundary
        // row is part of `(start, end]`; every earlier column is strictly past
        // the cursor in the opposite direction from {@link buildSeekWhere}
        // (asc → `lt`, desc → `gt`).
        const operator = seekBeforeOperator(pivotColumn.direction, isFinal);

        conditions.push({ [pivotColumn.field]: { [operator]: cursorValues[pivot] } });

        const [first] = conditions;

        branches.push(conditions.length === 1 && first !== undefined ? first : { AND: conditions });
    }

    return { OR: branches };
};

/** System fields a `select` projection always retains so cursors + by-id reuse keep working. */
const SELECT_SYSTEM_FIELDS = ["_id", "_creationTime"] as const;

/**
 * Project `page` rows down to `select` — plus the always-kept system fields and
 * the relation/`_count` keys attached by a `with` load (passed as `withInput`,
 * the same object handed to `findMany`). Returns the page unchanged when
 * `select` is undefined. Pure; callers apply it AFTER relation resolution +
 * cursor encoding so only the returned payload is trimmed (dependency tracking +
 * the cursor still see the full row).
 */
const applySelect = (
    page: Record<string, unknown>[],
    select: ReadonlyArray<string> | undefined,
    withInput?: Record<string, unknown>,
): Record<string, unknown>[] => {
    if (!select) {
        return page;
    }

    const keep = new Set<string>([...select, ...SELECT_SYSTEM_FIELDS, ...(withInput ? Object.keys(withInput) : [])]);

    return page.map((document) => {
        const projected: Record<string, unknown> = {};

        for (const key of keep) {
            if (key in document) {
                projected[key] = document[key];
            }
        }

        return projected;
    });
};

/**
 * The read-scope predicate that hides soft-deleted rows — `{ [field]: { isNull:
 * true } }` matching the live rows whose soft-delete column is null/absent — or
 * `undefined` when the table isn't `.softDelete()` or the read opted in via
 * `includeDeleted`. AND-merge it into a list read's `where` (the by-id path
 * never calls this, so `get`/`patch`/`replace`/`restore` still address the row).
 */
const softDeleteScope = (softDeleteMode: { field: string } | undefined, includeDeleted: boolean | undefined): undefined | WhereInput =>
    softDeleteMode && includeDeleted !== true ? { [softDeleteMode.field]: { isNull: true } } : undefined;

export { applySelect, buildSeekBeforeWhere, buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys, softDeleteScope };
export type { OrderByInput, OrderKey, QueryArgs, QueryPage, SortDirection };
