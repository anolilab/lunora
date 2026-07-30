/**
 * Read/write key-set algebra for range-precise reactive invalidation.
 *
 * A live query that reads through an index touches a contiguous slice of that
 * index, not the whole table. This module turns the reader's staged index
 * conditions into that slice ({@link buildIndexRange}) and turns a written row
 * into the index keys it occupies ({@link indexKeysForRow}), so the reactive
 * layer can ask the only question that matters: *did this write land inside
 * the slice that query read?*
 *
 * Ranges are normalized to **half-open `[lo, hi)`** over the order-preserving
 * encoding in `index-key-codec.ts`. Half-open is what makes exclusive bounds
 * correct on compound indexes: for an index on `(a, b)`, a row `(a=1, b=5)`
 * encodes to `enc(1)!enc(5)!…`, which sorts strictly ABOVE the bare bound
 * `enc(1)!enc(5)`. So `lt("b", 5)` is simply an exclusive upper bound at that
 * position, while `gt("b", 5)` raises the lower bound to `enc(1)!enc(5)￿` —
 * above every row with `b === 5`, whatever its trailing components.
 *
 * Safety rule, applied everywhere below: **narrowing is an optimization,
 * never a correctness input.** Any uncertainty — an unencodable value, an
 * unrecognised comparator, a condition on a field outside the index prefix —
 * yields `undefined`, and every consumer treats `undefined` as "assume
 * touched" and falls back to whole-table invalidation. Missing an
 * invalidation would serve stale data; an extra one only costs a re-run.
 */

import { encodeIndexKey, encodeIndexValue, KEY_HIGH, KEY_SEPARATOR } from "./index-key-codec";

/** A half-open `[lo, hi)` slice of one index on one table. */
interface KeyRange {
    /** Exclusive upper bound (encoded). */
    hi: string;
    /** Index name the range is expressed over. */
    index: string;
    /** Inclusive lower bound (encoded). */
    lo: string;
    /** Table the index belongs to. */
    table: string;
}

/** One index position a written row occupies. */
interface IndexKeyEntry {
    /** Index name the key is expressed over. */
    index: string;
    /** Encoded compound key of the row under that index. */
    key: string;
}

/** A staged index condition, as collected by the fluent reader's range builder. */
interface StagedCondition {
    comparator: string;
    field: string;
    value: unknown;
}

/**
 * Comparators the range builder understands. Anything else (`!=`, `LIKE`, a
 * relation marker) makes the range unprovable, so we bail to whole-table.
 */
const EQUALITY = "=";

/** `>` / `>=` constrain the slice from BELOW (they raise `lo`). */
const GREATER_THAN = new Set([">", ">="]);

/** `<` / `<=` constrain the slice from ABOVE (they lower `hi`). */
const LESS_THAN = new Set(["<", "<="]);

/**
 * Build the index slice a reader touched.
 *
 * Accepts the shape `withIndex` can actually produce: an equality prefix over
 * the leading index fields, optionally followed by range bounds on the next
 * field. Returns `undefined` when the conditions do not form a provable
 * contiguous slice — the caller then records a whole-table dependency.
 *
 * @param table the table being read
 * @param index the index name the reader staged
 * @param fields the index's fields, in index order
 * @param conditions the reader's staged conditions (already serialized values)
 * @param serialize canonicaliser applied to each bound before encoding, so the
 *   range is expressed in the same form the row keys will be
 */
const buildIndexRange = (
    table: string,
    index: string,
    fields: readonly string[],
    conditions: readonly StagedCondition[],
    serialize: (value: unknown) => unknown,
): KeyRange | undefined => {
    if (fields.length === 0) {
        return undefined;
    }

    const equalities: unknown[] = [];
    let boundField: string | undefined;
    let lowerValue: unknown;
    let lowerExclusive = false;
    let upperValue: unknown;
    let upperExclusive = false;
    let sawBound = false;

    for (const condition of conditions) {
        const position = fields.indexOf(condition.field);

        // A condition on a field outside this index cannot be positioned
        // against it — the slice would be a guess, so refuse to narrow.
        if (position === -1) {
            return undefined;
        }

        if (condition.comparator === EQUALITY) {
            // Equalities must form an uninterrupted prefix, and must not
            // follow a range bound (that would no longer be contiguous).
            if (sawBound || position !== equalities.length) {
                return undefined;
            }

            equalities.push(serialize(condition.value));

            continue;
        }

        const raisesLo = GREATER_THAN.has(condition.comparator);
        const lowersHi = LESS_THAN.has(condition.comparator);

        if (!raisesLo && !lowersHi) {
            return undefined;
        }

        // Bounds are only expressible on the field directly after the
        // equality prefix, and every bound must target that same field.
        if (position !== equalities.length || (boundField !== undefined && boundField !== condition.field)) {
            return undefined;
        }

        boundField = condition.field;
        sawBound = true;

        if (raisesLo) {
            // A second lower bound on the same field would need intersection;
            // the reader never emits one, so refuse rather than guess.
            if (lowerValue !== undefined) {
                return undefined;
            }

            lowerValue = serialize(condition.value);
            lowerExclusive = condition.comparator === ">";
        } else {
            if (upperValue !== undefined) {
                return undefined;
            }

            upperValue = serialize(condition.value);
            upperExclusive = condition.comparator === "<";
        }
    }

    const prefix = encodeIndexKey(equalities);

    if (prefix === undefined) {
        return undefined;
    }

    // `lo` starts inclusive at the prefix and `hi` exclusive just past it; the
    // bounds below tighten one or both within that prefix.
    let lo = prefix;
    let hi = prefix + KEY_HIGH;

    if (lowerValue !== undefined) {
        const encoded = encodeIndexValue(lowerValue);

        if (encoded === undefined) {
            return undefined;
        }

        const at = prefix === "" ? encoded : prefix + KEY_SEPARATOR + encoded;

        // `>` must clear every row whose bound component equals the value,
        // including those with trailing compound components — appending the
        // high sentinel lifts the inclusive bound just past all of them.
        lo = lowerExclusive ? at + KEY_HIGH : at;
    }

    if (upperValue !== undefined) {
        const encoded = encodeIndexValue(upperValue);

        if (encoded === undefined) {
            return undefined;
        }

        const at = prefix === "" ? encoded : prefix + KEY_SEPARATOR + encoded;

        // `<` is already exclusive at the bare position (rows with trailing
        // components sort above it); `<=` must additionally admit them.
        hi = upperExclusive ? at : at + KEY_HIGH;
    }

    // An empty or inverted slice matches nothing; treat it as unprovable
    // rather than emitting a range no write can ever fall into.
    if (lo >= hi) {
        return undefined;
    }

    return { hi, index, lo, table };
};

/**
 * Encode the index positions a row occupies, one entry per index whose key is
 * fully encodable. Indexes with an unencodable component are omitted — the
 * caller must therefore treat a missing index as "unknown", not "no match".
 *
 * @param indexes the table's index definitions, in schema order
 * @param row the row's field values (post-write for an insert/patch, pre-write
 *   for the outgoing position of a moved row)
 * @param serialize canonicaliser matching the one used to build ranges
 */
const indexKeysForRow = (
    indexes: readonly { fields: readonly string[]; name: string }[],
    row: Record<string, unknown>,
    serialize: (value: unknown) => unknown,
): IndexKeyEntry[] => {
    const entries: IndexKeyEntry[] = [];

    for (const index of indexes) {
        const key = encodeIndexKey(index.fields.map((field) => serialize(row[field])));

        if (key !== undefined) {
            entries.push({ index: index.name, key });
        }
    }

    return entries;
};

/** Does `entry` fall inside the half-open slice `range`? */
const rangeContains = (range: KeyRange, entry: IndexKeyEntry): boolean =>
    range.index === entry.index && entry.key >= range.lo && entry.key < range.hi;

/**
 * Did any of `keys` land inside any of `ranges`?
 *
 * Returns `true` (assume touched) whenever either side is unknown, so callers
 * can pass through partial information without special-casing it.
 */
const keysTouchRanges = (ranges: readonly KeyRange[] | undefined, keys: readonly IndexKeyEntry[] | undefined): boolean => {
    if (!ranges || ranges.length === 0 || !keys || keys.length === 0) {
        return true;
    }

    // A write is only provably outside the read slice when every range the
    // query read is expressed over an index we actually computed a key for.
    // A range over an index missing from `keys` (unencodable component) is
    // unprovable, so it counts as touched.
    return ranges.some((range) => {
        const matching = keys.filter((entry) => entry.index === range.index);

        if (matching.length === 0) {
            return true;
        }

        return matching.some((entry) => rangeContains(range, entry));
    });
};

/**
 * Dependency-set encoding of a read range, for the reactive cache's string
 * index. Table first so `tableFromDepKey` keeps working; the `~r` marker keeps
 * it disjoint from the `table:id` and `table:*scan` forms. None of the encoded
 * components can contain `:`.
 */
const rangeDepKey = (range: KeyRange): string => `${range.table}:~r:${range.index}:${range.lo}:${range.hi}`;

/** Parse a {@link rangeDepKey} back into a {@link KeyRange}, or `undefined` if it isn't one. */
const parseRangeDepKey = (dep: string): KeyRange | undefined => {
    const parts = dep.split(":");

    if (parts.length !== 5 || parts[1] !== "~r") {
        return undefined;
    }

    const [table, , index, lo, hi] = parts as [string, string, string, string, string];

    return { hi, index, lo, table };
};

export { buildIndexRange, indexKeysForRow, keysTouchRanges, parseRangeDepKey, rangeContains, rangeDepKey };
export type { IndexKeyEntry, KeyRange, StagedCondition };
