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
 * always `null`, a `number`, or a `string`. That collapses booleans (→ 0/1),
 * bigints (→ text) and objects (→ JSON text) before they reach us, so the
 * comparable domain maps 1:1 onto SQLite's storage classes.
 *
 * Ordering contract (matches SQLite's `NULL < INTEGER/REAL < TEXT`):
 *
 * - `null`   → tag `"0"`
 * - number   → tag `"1"` + 16 hex chars (order-preserving IEEE-754)
 * - string   → tag `"2"` + UTF-8 bytes as hex
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

/**
 * Encode a float64 so that lexicographic order over the hex output matches
 * numeric order over the input.
 *
 * The standard total-order transform: view the double as big-endian bits; for
 * negatives (sign bit set) flip every bit so more-negative sorts lower, for
 * non-negatives flip only the sign bit so they all sort above the negatives.
 * Fixed 16-char width keeps compound keys aligned.
 */
const encodeNumber = (value: number): string => {
    const view = new DataView(new ArrayBuffer(8));

    view.setFloat64(0, value, false);

    let high = view.getUint32(0, false);
    let low = view.getUint32(4, false);

    if ((high & 0x80_00_00_00) === 0) {
        // Non-negative: set the sign bit so it sorts above every negative.
        // `>>> 0` is load-bearing — JS bitwise ops yield a SIGNED int32, and a
        // negative `high` would render as "-3ff00000" and destroy the ordering.
        high = (high ^ 0x80_00_00_00) >>> 0;
    } else {
        // Negative: flip everything so larger magnitudes sort lower.
        high = ~high >>> 0;
        low = ~low >>> 0;
    }

    return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
};

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

        // -0 and +0 compare equal in SQL; normalize so they encode identically.
        return `1${encodeNumber(value === 0 ? 0 : value)}`;
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
const encodeIndexKey = (values: readonly unknown[]): string | undefined => {
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
