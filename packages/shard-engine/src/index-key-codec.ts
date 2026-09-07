/**
 * Order-preserving codec for index key values.
 *
 * The reactive layer needs to decide, on the write path, whether a row falls
 * inside the key range some live query read (see `read-write-set.ts`). Doing
 * that with a comparison means encoding index values into strings whose
 * lexicographic order matches the order SQLite uses when it evaluates the
 * query's own `WHERE` clause — otherwise a row could sort outside a range it
 * actually belongs to and the subscription would miss its invalidation.
 *
 * The codec therefore operates on the **serialized** value (the output of
 * `serializeSqlValue`), which is the exact form the where-compiler binds:
 * always `null`, a `number`, or a `string`. That collapses booleans (→ 0/1) and
 * objects (→ JSON text) before they reach us, so the comparable domain maps 1:1
 * onto SQLite's storage classes.
 *
 * `bigint` arrives as text too, but as the fixed-width order-preserving key
 * built in `sql-projection.ts` rather than as `String(value)` — which is the
 * point: the key's lexicographic order already matches numeric order, so hexing
 * its UTF-8 bytes below preserves that, and a range over a `v.bigint()` column
 * narrows correctly instead of conservatively.
 *
 * Bytes arrive as base64, which is **not** order-preserving — the standard
 * alphabet puts `/` (0x2F) below `A` (0x41), so `[0xFF]` encodes to `"/w=="` and
 * sorts BELOW `[0x00]`'s `"AA=="`. Equality and prefix narrowing are unaffected
 * (the mapping is injective), but a range or `ORDER BY` over a `v.bytes()`
 * column is ordered by base64 text rather than by bytes. Not a regression —
 * bytes could not be stored at all before — and not fixed here, because an
 * order-preserving binary encoding is a stored-format change.
 *
 * Ordering contract (matches SQLite's `NULL < INTEGER/REAL < TEXT`):
 *
 * - `null`   → tag `"0"`
 * - number   → tag `"1"` + `float64SqlKey` (16 hex chars, order-preserving IEEE-754)
 * - string   → tag `"2"` + UTF-8 bytes as hex
 *
 * The number half is `sql-projection.ts`'s key rather than a copy of it, because
 * the `.global()` store writes that same key into an untyped column: narrowing
 * is only correct while its numeric order and the stored one are one order.
 *
 * The tags are ASCII digits, so tag order alone already reproduces the storage
 * class order. Every emitted character is ASCII (`0-9a-f`, plus the separator
 * and the high sentinel), which matters: JS compares strings by UTF-16 code
 * unit while SQLite's default `BINARY` collation compares UTF-8 bytes. Those
 * two orders disagree for astral-plane text, so we never emit raw text —
 * strings go out as hex of their UTF-8 bytes, making our comparison
 * byte-for-byte identical to `BINARY`.
 *
 * NOTE: this assumes indexed text columns use the default `BINARY` collation.
 * A `NOCASE` index would order differently; the schema layer does not emit one
 * today, and {@link encodeIndexValue} would need a collation-aware branch if it
 * ever does.
 *
 * Values we cannot faithfully order (`undefined`, `NaN`, `±Infinity`) return
 * {@link UNENCODABLE}. Callers MUST treat that as "cannot narrow" and fall back
 * to the conservative whole-table dependency — never as "no match".
 */

import { float64SqlKey } from "./sql-projection";

/**
 * Separator between components of a compound index key. Must sort BELOW every
 * character {@link encodeIndexValue} can emit (lowest is the tag `"0"`, 0x30)
 * so that a shorter key sorts before any key extending it — the property that
 * makes prefix ranges over compound indexes work.
 */
const KEY_SEPARATOR = "!";

/**
 * Sentinel that sorts ABOVE every character {@link encodeIndexValue} emits.
 * Appending it to a bound turns "everything at this prefix" into a clean
 * half-open upper bound, and turns an exclusive lower bound into an inclusive
 * one (see `read-write-set.ts`).
 */
const KEY_HIGH = "￿";

/** Returned when a value has no faithful order-preserving encoding. */
const UNENCODABLE = undefined;

/** UTF-8 bytes of `value` as lowercase hex — byte order == SQLite `BINARY` order. */
const encodeString = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let out = "";

    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, "0");
    }

    return out;
};

/**
 * Encode one already-serialized index value. Returns {@link UNENCODABLE} when
 * the value has no faithful ordering — callers must degrade to a whole-table
 * dependency rather than assume a miss.
 */
const encodeIndexValue = (value: unknown): string | undefined => {
    if (value === null) {
        return "0";
    }

    if (typeof value === "number") {
        // NaN/±Infinity have no meaningful position in SQLite's numeric order
        // (and never round-trip through JSON), so refuse to place them.
        if (!Number.isFinite(value)) {
            return UNENCODABLE;
        }

        // `float64SqlKey` normalizes -0 to +0, which is what SQL needs — the
        // two compare equal there, so two keys would split one value.
        return `1${float64SqlKey(value)}`;
    }

    if (typeof value === "string") {
        return `2${encodeString(value)}`;
    }

    return UNENCODABLE;
};

/**
 * Encode a full compound index key (one component per indexed field, in index
 * order). Returns {@link UNENCODABLE} if ANY component is unencodable — a key
 * with a hole cannot be positioned against a range.
 */
const encodeIndexKey = (values: ReadonlyArray<unknown>): string | undefined => {
    const parts: string[] = [];

    for (const value of values) {
        const encoded = encodeIndexValue(value);

        if (encoded === UNENCODABLE) {
            return UNENCODABLE;
        }

        parts.push(encoded);
    }

    return parts.join(KEY_SEPARATOR);
};

export { encodeIndexKey, encodeIndexValue, KEY_HIGH, KEY_SEPARATOR };
