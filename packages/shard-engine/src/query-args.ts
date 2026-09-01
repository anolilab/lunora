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
 *
 * One thing it is NOT free of is the dialect's NULL ordering. A keyset seek has
 * to place NULLs exactly where the ORDER BY does or a nullable ordered column
 * cannot be paged at all, and neither ORDER BY builder emits an explicit
 * `NULLS FIRST`/`NULLS LAST`. {@link pivotCondition} therefore assumes the
 * SQLite/MySQL default (NULLs first ascending, last descending), which covers
 * both stores that page with these cursors. Postgres defaults the other way, so
 * a nullable ordered column there needs its ORDER BY made explicit before the
 * two agree.
 */
import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { OrderByInput, OrderKey, SortDirection } from "./schema-types";
import type { WhereInput } from "./where-types";

/** The implicit tiebreak appended to every sort so the order is total. */
const TIEBREAK_FIELD = "id";

/**
 * Which way the implicit `id` tiebreak sorts: the same way the last real sort
 * key does.
 *
 * It used to be pinned `asc`. That made a descending read emit
 * `_creationTime DESC, id ASC` — two directions in one ORDER BY, which no
 * single-direction index can satisfy. SQLite answered it with
 * `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`, sorting each tie group instead
 * of walking the index backwards, and a descending page measured 1.4-2.0x
 * slower than the aligned form. The DO builds every declared index as
 * `(<fields>, _creationTime, id)`, so following the last key's direction is
 * exactly what lets that index be read forwards OR backwards.
 *
 * {@link buildSeek} and every ORDER BY builder MUST use this one rule. A cursor
 * seek that disagrees with its own ORDER BY about tie direction skips or repeats
 * rows at a page boundary where the sort keys tie.
 */
const tiebreakDirectionFor = (keys: ReadonlyArray<{ direction?: string }>): SortDirection => (keys.at(-1)?.direction === "desc" ? "desc" : "asc");

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

/** Any code point outside ASCII — the test gating {@link toBase64}'s fast path. */
const NON_ASCII = /[\u0080-\u{10FFFF}]/u;

const toBase64 = (text: string): string => {
    // `btoa` already takes a latin-1 string, and an all-ASCII string IS its own
    // UTF-8 byte sequence — so for one the encode and the byte-by-byte rebuild
    // below are both the identity. Cursors are `JSON.stringify` of a creation
    // time and an id, so that is nearly always the case, and skipping the two
    // passes measured ~7x on the encode. A non-ASCII id pays one extra scan.
    if (!NON_ASCII.test(text)) {
        return btoa(text);
    }

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
 * Prefix stamped on every cursor this build mints.
 *
 * A cursor is an opaque `[...sortValues, id]` tuple with no self-describing
 * shape, so its BYTES cannot tell you which seek predicate was meant to read
 * them. When the implicit `id` tiebreak changed direction (see
 * {@link tiebreakDirectionFor}), the bytes stayed identical and only their
 * MEANING moved: a cursor minted under `… DESC, id ASC` fed to the `… DESC,
 * id DESC` predicate seeks the wrong way through a group of rows that tie on
 * the real sort key.
 *
 * That is not hypothetical. A mounted paginated feed holds its page boundaries
 * in client state for the life of the component and replays them on every
 * reactive re-run, so a deploy hands pre-change cursors straight to the changed
 * predicate. Measured on six rows tied on one `_creationTime`: the page came
 * back holding a row from the PREVIOUS page while four rows became unreachable.
 *
 * `~` is deliberately outside the base64 alphabet, so a legacy (unprefixed)
 * cursor can never be mistaken for a prefixed one whatever its payload.
 */
const CURSOR_PREFIX = "~2";

/**
 * Encode the sort key of `doc` (the values of each `orderBy` field, then its
 * id) as an opaque base64 cursor. The id is always included so the seek has a
 * unique terminal column.
 */
const encodeCursor = (record: Record<string, unknown>, keys: OrderKey[]): string => {
    const values = keys.map((key) => record[key.field]);

    values.push(record["_id"]);

    // `encodeWire`, not a bare `JSON.stringify`: the values come straight out of
    // a decoded document, so ordering by a `v.bigint()` column put a real bigint
    // in here and threw `TypeError: Do not know how to serialize a BigInt` — the
    // same defect class this store's blob codec exists to fix, surviving in the
    // cursor. Identity for pure-JSON keys, so existing cursors are byte-identical.
    return CURSOR_PREFIX + toBase64(JSON.stringify(encodeWire(values)));
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
    // Refuse an unprefixed cursor rather than seek with it. It was minted by a
    // build whose tiebreak ran the other way, so reading it here returns rows
    // from the wrong side of the tie group — silently, and looking exactly like
    // a correct page. A typed 400 is recoverable (the client resets the feed);
    // wrong rows presented as right ones are not.
    if (!cursor.startsWith(CURSOR_PREFIX)) {
        throw invalidCursor();
    }

    let decoded: unknown;

    try {
        decoded = decodeWire(JSON.parse(fromBase64(cursor.slice(CURSOR_PREFIX.length))));
    } catch {
        // atob() throws InvalidCharacterError on non-base64 input, JSON.parse
        // throws SyntaxError on malformed JSON, and `decodeWire` throws
        // RangeError past its depth/bigint bounds. Normalize every
        // client-supplied failure to the same typed 400 error.
        throw invalidCursor();
    }

    if (!Array.isArray(decoded)) {
        throw invalidCursor();
    }

    return decoded;
};

/**
 * Framework columns the store stamps on every row, so a seek over one never
 * needs {@link pivotCondition}'s NULL arm.
 *
 * That arm is correct but not free: `OR col IS NULL` on the pivot is a second
 * disjunct the planner cannot answer from the same index range, and the DEFAULT
 * ordering (`_creationTime DESC` plus the `id` tiebreak) is the hot path every
 * unordered `paginate` takes. Both of those columns are written by the store
 * itself and can never be null, so the arm would only ever cost — a user-declared
 * ordered column, which is the one that can actually hold NULL, still gets it.
 */
const NEVER_NULL_FIELDS = new Set(["_creationTime", "_id", "id"]);

/**
 * The pivot comparison for ONE column of the lexicographic seek: the rows on the
 * wanted side of `value` under this column's direction.
 *
 * `wantLater` is which side is being sought — `true` for the strict "after"
 * seek, `false` for the mirrored "at or before" bound. `inclusive` applies to the
 * terminal column only, so a page's own end cursor stays inside the page it
 * terminates.
 *
 * NULL is why this is not a comparator lookup. `col > NULL` and `col < NULL` are
 * both UNKNOWN, so no comparator expresses either side of a NULL pivot, and none
 * matches a NULL row sitting on the far side of a non-null pivot — a nullable
 * ordered column cannot be paged without writing the ordering's NULL placement
 * out. Neither ORDER BY builder emits `NULLS FIRST`/`NULLS LAST`, so the dialect
 * default stands: SQLite and MySQL sort NULLs FIRST ascending, LAST descending.
 * Hence a non-null row is on the wanted side of a NULL pivot exactly when
 * `ascending === wantLater`, and NULL rows are on the wanted side of a non-null
 * pivot exactly when it is not.
 *
 * `undefined` is the same pivot as `null`: a column absent from a document reads
 * back as SQL NULL, and {@link encodeCursor} takes the ordered field verbatim, so
 * an absent one arrives here as `undefined`.
 */
const pivotCondition = (column: OrderKey, value: unknown, wantLater: boolean, inclusive: boolean): WhereInput => {
    const { field } = column;
    const nonNullWanted = (column.direction !== "desc") === wantLater;

    if (value === null || value === undefined) {
        if (nonNullWanted) {
            // Inclusive at a NULL pivot is "the non-nulls, plus the NULL group itself" — every row.
            return inclusive ? { OR: [{ [field]: { isNull: false } }, { [field]: { isNull: true } }] } : { [field]: { isNull: false } };
        }

        // Nothing sorts past NULL on this side; inclusive still keeps the NULL group.
        return inclusive ? { [field]: { isNull: true } } : { OR: [] };
    }

    let operator = nonNullWanted ? "gt" : "lt";

    if (inclusive) {
        operator = nonNullWanted ? "gte" : "lte";
    }

    const comparison: WhereInput = { [field]: { [operator]: value } };

    if (nonNullWanted || NEVER_NULL_FIELDS.has(field)) {
        return comparison;
    }

    // The NULL rows sort on the wanted side of this pivot and no comparator can reach them.
    return { OR: [comparison, { [field]: { isNull: true } }] };
};

/**
 * Shared lexicographic-seek builder behind {@link buildSeekWhere} /
 * {@link buildSeekBeforeWhere}: one disjunct per pivot column, each ANDing the
 * prefix equalities with the pivot comparison for the side being sought.
 */
const buildSeek = (keys: OrderKey[], cursorValues: unknown[], wantLater: boolean, inclusiveFinal: boolean): WhereInput => {
    const columns: OrderKey[] = keys.some((key) => ID_FIELDS.has(key.field))
        ? keys
        : [...keys, { direction: tiebreakDirectionFor(keys), field: TIEBREAK_FIELD }];

    const branches: WhereInput[] = [];

    for (const [pivot, pivotColumn] of columns.entries()) {
        const conditions: WhereInput[] = [];

        for (const [prefix, prefixColumn] of columns.slice(0, pivot).entries()) {
            conditions.push({ [prefixColumn.field]: { eq: cursorValues[prefix] } });
        }

        conditions.push(pivotCondition(pivotColumn, cursorValues[pivot], wantLater, inclusiveFinal && pivot === columns.length - 1));

        // Wrap multi-condition branches so each disjunct is explicitly grouped
        // rather than leaning on SQL's AND-over-OR precedence.
        const [first] = conditions;

        branches.push(conditions.length === 1 && first !== undefined ? first : { AND: conditions });
    }

    return { OR: branches };
};

/**
 * Build the `where` tree that selects rows strictly after the cursor under the
 * given sort. For keys `[a ASC, b DESC]` (plus the id tiebreak) it expands to
 * the lexicographic seek `(a > ?) OR (a = ? AND b < ?) OR (a = ? AND b = ? AND id > ?)`,
 * letting the shared compiler render it per dialect. A nullable ordered column
 * swaps its comparator for the NULL-aware form — see {@link pivotCondition}.
 */
const buildSeekWhere = (keys: OrderKey[], cursorValues: unknown[]): WhereInput => buildSeek(keys, cursorValues, true, false);

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
const buildSeekBeforeWhere = (keys: OrderKey[], cursorValues: unknown[]): WhereInput => buildSeek(keys, cursorValues, false, true);

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

/**
 * The same rule as {@link softDeleteScope}, applied to a decoded row instead of
 * compiled into a `where`: is this row LIVE?
 *
 * The aggregate companions tally live rows only, and a companion row carries no
 * marker column of its own — so the tally is only as correct as this predicate's
 * agreement with the scope it stands in for. They live adjacent for that reason;
 * a difference between them is a maintained counter that silently disagrees with
 * the scan it replaces.
 *
 * `field` `undefined` means the table has no soft-delete mode, and every row is
 * live. Not to be confused with the exported `isSoftDeleted` in
 * `external-source-pull.ts`, which reads an UPSTREAM tombstone column with
 * deliberately looser semantics (`false`/`0` are live, `""` is deleted).
 * @returns `true` when the row contributes to a companion tally
 */
const isLiveForCompanion = (document: Record<string, unknown>, field: string | undefined): boolean =>
    field === undefined || document[field] === null || document[field] === undefined;

export {
    applySelect,
    buildSeekBeforeWhere,
    buildSeekWhere,
    CURSOR_PREFIX,
    decodeCursor,
    encodeCursor,
    fromBase64,
    invalidCursor,
    isLiveForCompanion,
    normalizeOrderKeys,
    softDeleteScope,
    tiebreakDirectionFor,
    toBase64,
};

export { type OrderByInput, type OrderKey, type QueryArgs, type QueryPage, type SortDirection } from "./schema-types";
