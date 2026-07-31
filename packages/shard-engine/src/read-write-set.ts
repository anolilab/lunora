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
 * Ranges travel as OBJECTS, never encoded into the row-dependency string
 * space. A document id is arbitrary user data, so any scheme that packed a
 * range into the same strings could be forged by an id shaped like one, and
 * a forged range reads as "this table is narrowed" — which suppresses
 * invalidations rather than adding them.
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

/** `&lt;` / `&lt;=` constrain the slice from ABOVE (they lower `hi`). */
const LESS_THAN = new Set(["<", "<="]);

/**
 * The reader's conditions, reduced to the only shape a contiguous slice can
 * take: an equality prefix plus at most one bound on either side of the next
 * field.
 */
interface ParsedConditions {
    /** Serialized equality values, one per leading index field. */
    equalities: unknown[];
    /** Serialized lower bound, when one was staged. */
    lower?: unknown;
    /** `true` for `>` (exclusive), `false` for `>=`. */
    lowerExclusive: boolean;
    /** Serialized upper bound, when one was staged. */
    upper?: unknown;
    /** `true` for `&lt;` (exclusive), `false` for `&lt;=`. */
    upperExclusive: boolean;
}

/**
 * Can `condition` extend a contiguous slice, given how many equalities have
 * been consumed so far and which field (if any) already carries a bound?
 *
 * Rejects a field outside the index, a comparator we do not model, a condition
 * that skips or revisits a position in the index order, an equality arriving
 * after a bound, and a bound on a second field — each of which would make the
 * slice non-contiguous, hence unprovable.
 */
const isContiguous = (fields: ReadonlyArray<string>, condition: StagedCondition, consumed: number, boundField: string | undefined): boolean => {
    const isEquality = condition.comparator === EQUALITY;
    const isBound = GREATER_THAN.has(condition.comparator) || LESS_THAN.has(condition.comparator);

    if (!isEquality && !isBound) {
        return false;
    }

    if (fields.indexOf(condition.field) !== consumed) {
        return false;
    }

    if (boundField === undefined) {
        return true;
    }

    // A bound is already staged: only further bounds on that same field can
    // still describe one contiguous slice.
    return !isEquality && boundField === condition.field;
};

/**
 * Reduce staged conditions to a {@link ParsedConditions}, or `undefined` when
 * they cannot describe one contiguous slice — a condition off the index, an
 * equality interrupting the prefix or following a bound, a comparator we do
 * not model, or two bounds on the same side (which would need intersection).
 */
const parseConditions = (
    fields: ReadonlyArray<string>,
    conditions: ReadonlyArray<StagedCondition>,
    serialize: (value: unknown) => unknown,
): ParsedConditions | undefined => {
    const parsed: ParsedConditions = { equalities: [], lowerExclusive: false, upperExclusive: false };
    let boundField: string | undefined;

    for (const condition of conditions) {
        const isEquality = condition.comparator === EQUALITY;
        const raisesLo = GREATER_THAN.has(condition.comparator);

        if (!isContiguous(fields, condition, parsed.equalities.length, boundField)) {
            return undefined;
        }

        if (isEquality) {
            parsed.equalities.push(serialize(condition.value));

            continue;
        }

        boundField = condition.field;

        if (raisesLo) {
            if (parsed.lower !== undefined) {
                return undefined;
            }

            parsed.lower = serialize(condition.value);
            parsed.lowerExclusive = condition.comparator === ">";
        } else {
            if (parsed.upper !== undefined) {
                return undefined;
            }

            parsed.upper = serialize(condition.value);
            parsed.upperExclusive = condition.comparator === "<";
        }
    }

    return parsed;
};

/** Position a bound value within the equality prefix, or `undefined` if unencodable. */
const boundAt = (prefix: string, value: unknown): string | undefined => {
    const encoded = encodeIndexValue(value);

    if (encoded === undefined) {
        return undefined;
    }

    return prefix === "" ? encoded : prefix + KEY_SEPARATOR + encoded;
};

/**
 * Build the index slice a reader touched.
 *
 * Accepts the shape `withIndex` can actually produce: an equality prefix over
 * the leading index fields, optionally followed by range bounds on the next
 * field. Returns `undefined` when the conditions do not form a provable
 * contiguous slice — the caller then records a whole-table dependency.
 * @param table the table being read
 * @param index the index name the reader staged
 * @param fields the index's fields, in index order
 * @param conditions the reader's staged conditions (already serialized values)
 * @param serialize canonicaliser applied to each bound before encoding, so the
 * range is expressed in the same form the row keys will be
 */
const buildIndexRange = (
    table: string,
    index: string,
    fields: ReadonlyArray<string>,
    conditions: ReadonlyArray<StagedCondition>,
    serialize: (value: unknown) => unknown,
): KeyRange | undefined => {
    if (fields.length === 0) {
        return undefined;
    }

    const parsed = parseConditions(fields, conditions, serialize);

    if (!parsed) {
        return undefined;
    }

    const prefix = encodeIndexKey(parsed.equalities);

    if (prefix === undefined) {
        return undefined;
    }

    // `lo` starts inclusive at the prefix and `hi` exclusive just past it; the
    // bounds below tighten one or both within that prefix.
    let lo = prefix;
    let hi = prefix + KEY_HIGH;

    if (parsed.lower !== undefined) {
        const at = boundAt(prefix, parsed.lower);

        if (at === undefined) {
            return undefined;
        }

        // `>` must clear every row whose bound component equals the value,
        // including those with trailing compound components — appending the
        // high sentinel lifts the inclusive bound just past all of them.
        lo = parsed.lowerExclusive ? at + KEY_HIGH : at;
    }

    if (parsed.upper !== undefined) {
        const at = boundAt(prefix, parsed.upper);

        if (at === undefined) {
            return undefined;
        }

        // `<` is already exclusive at the bare position (rows with trailing
        // components sort above it); `<=` must additionally admit them.
        hi = parsed.upperExclusive ? at : at + KEY_HIGH;
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
 * @param indexes the table's index definitions, in schema order
 * @param row the row's field values (post-write for an insert/patch, pre-write
 * for the outgoing position of a moved row)
 * @param serialize canonicaliser matching the one used to build ranges
 */
const indexKeysForRow = (
    indexes: ReadonlyArray<{ fields: ReadonlyArray<string>; name: string }>,
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
const rangeContains = (range: KeyRange, entry: IndexKeyEntry): boolean => range.index === entry.index && entry.key >= range.lo && entry.key < range.hi;

/**
 * Did any of `keys` land inside any of `ranges`?
 *
 * Returns `true` (assume touched) whenever either side is unknown, so callers
 * can pass through partial information without special-casing it.
 */
const keysTouchRanges = (ranges: ReadonlyArray<KeyRange> | undefined, keys: ReadonlyArray<IndexKeyEntry> | undefined): boolean => {
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

export { buildIndexRange, indexKeysForRow, keysTouchRanges, rangeContains };
export type { IndexKeyEntry, KeyRange, StagedCondition };
