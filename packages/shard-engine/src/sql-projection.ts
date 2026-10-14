/**
 * The single definition of how a value that SQLite cannot compare in its
 * wire-tagged form is projected into one it can.
 *
 * `encodeDocJson` (`do-sql.ts`) stores the projection at `$.field`, and
 * `serializeSqlValue` (`serialize-sql.ts`) binds it as the comparison value.
 * Those are the two sides of every `json_extract(__doc__, '$.f') <op> ?` this
 * store emits, so they are one function here rather than two that a comment
 * asks to agree — a `bigint` stored one way and bound another is invisible to
 * types and surfaces only as wrong rows.
 *
 * ## Why `bigint` is a zero-padded string and not a number
 *
 * The obvious projection is `Number(value)`. It is wrong, and wrong in the
 * direction that matters: `Number` collapses every `bigint` past 2^53 onto the
 * nearest double, so `9007199254740991n`, `…992n` and `…993n` all become
 * `9007199254740992`. A `where` for one of them then matches the other two —
 * **false positives from an equality predicate**, which is unusable when the
 * predicate is an authorization filter, and which makes a `unique` index reject
 * two genuinely different ids as a duplicate. Storing exact digits and
 * comparing them as text is the only shape that keeps `=` honest.
 *
 * Plain decimal text (`"10"`) is exact for `=` but sorts `"9"` after `"10"`, so
 * ranges and `ORDER BY` would silently return the wrong rows instead. Padding
 * every magnitude to one width fixes that: with a fixed width, lexicographic
 * order over the digits *is* numeric order. Negatives take the nines' complement
 * of the magnitude under a lower sign character, so the ordering stays total
 * across zero.
 *
 * The cost is `SUM`: `"1000…0010"` is not a number SQLite can add up. The
 * aggregate reader refuses a `v.bigint()` field on the scan path rather than
 * return the 1.5e40 that falls out of coercing padded text (`ctx-db.ts`), and
 * the maintained companion refuses a value it cannot hold exactly
 * (`aggregate-tally.ts`). Verified against a real SQLite build: `=` is exact at
 * 2^53 and either side of it, `ORDER BY` is numeric across a 22-digit range
 * including negatives, and `SUM` over the padded form is garbage.
 *
 * Storing the digits as a raw JSON number literal was the other candidate —
 * SQLite genuinely holds exact int64 through `json_extract` — but it is a trap:
 * reading such a row back throws `RangeError: Value is too large to be
 * represented as a JavaScript number` out of the driver, so the row becomes
 * unreadable. The comparison side could not bind an exact int64 either.
 */

import { LunoraError } from "@lunora/errors";

import { toBase64 } from "../../../shared/base64";
import type { KindedValidator } from "../../../shared/effective-kind";
import { effectiveKind } from "../../../shared/effective-kind";

/**
 * Digits of magnitude a projected `bigint` may carry. 39 digits reach 1e39,
 * clearing the unsigned 128-bit maximum (~3.4e38), so every ordinary use — money
 * in minor units, snowflake ids, epoch nanoseconds, UUID-as-integer — fits with
 * room to spare.
 *
 * ponytail: a fixed width means a hard ceiling, and a value past it is refused
 * rather than silently mis-sorted. Widening is a stored-format change; the
 * upgrade path for genuinely unbounded integers (a 256-bit content hash, say)
 * is a length-prefixed key, which costs ordering complexity nothing needs today.
 */
const BIGINT_KEY_DIGITS = 39;

/** Sign characters. `"0"` < `"1"` in ASCII, so every negative key sorts below every non-negative one. */
const NEGATIVE = "0";
const NON_NEGATIVE = "1";

/** Nines' complement of a digit string — its own inverse, which is what makes the decode a re-application of the encode. */
const ninesComplement = (digits: string): string => Array.from(digits, (digit) => String(9 - Number(digit))).join("");

/**
 * An order-preserving, exactly-reversible text key for `value`.
 *
 * Non-negative values are the magnitude zero-padded to {@link BIGINT_KEY_DIGITS}
 * under the `"1"` prefix, so equal-width digit strings compare numerically.
 * Negative values take the nines' complement of the padded magnitude under
 * `"0"`, which inverts the order within the negatives — `-200` sorts below `-9`
 * — while the prefix keeps all of them below zero.
 * @throws LunoraError `BAD_REQUEST` when the magnitude exceeds the fixed key width
 */
const bigintSqlKey = (value: bigint): string => {
    const negative = value < 0n;
    const magnitude = (negative ? -value : value).toString();

    if (magnitude.length > BIGINT_KEY_DIGITS) {
        throw new LunoraError(
            "BAD_REQUEST",
            `bigint ${value.toString()} has ${String(magnitude.length)} digits, over the ${String(BIGINT_KEY_DIGITS)}-digit limit for a queryable column`,
        );
    }

    const padded = magnitude.padStart(BIGINT_KEY_DIGITS, "0");

    return negative ? NEGATIVE + ninesComplement(padded) : NON_NEGATIVE + padded;
};

/** A key's magnitude half: digits only, so a stored value that merely happens to be 40 characters cannot be mistaken for one. */
const BIGINT_KEY_DIGITS_RE = /^\d+$/u;

/**
 * Inverse of {@link bigintSqlKey}, or `undefined` when `raw` is not a key.
 *
 * Lives beside the encoder rather than beside its caller (`@lunora/sql-store`'s
 * `value-codec.ts`, which reverses a stored `.global()` column): the two halves
 * share the width, the sign characters and the complement, and a decoder a file
 * away from them is how a padding change ships as a silent mis-read.
 *
 * The shape test is exact rather than heuristic: a key is 40 characters, a sign
 * character in `{"0","1"}` followed by 39 digits. That is *nearly* disjoint from
 * the plain decimal text an earlier build stored, but not entirely — the two
 * cases where they overlap are both past what {@link bigintSqlKey} will now
 * write, so no value this encoder produces can be misread:
 *
 * A legacy **positive** of exactly 40 digits starts with a digit, and a leading
 * `"1"` reads as the non-negative sign — so a stored value in `[1e39, 2e39)`
 * decodes as `value − 1e39`. The encoder refuses a magnitude that wide outright
 * (39 digits is the ceiling), so only a row written before the key encoding can
 * be one.
 *
 * A legacy **negative** is `"-"` plus its digits, which no sign character
 * matches, so it falls through to the plain `BigInt(raw)` path and decodes
 * correctly. The one at 40 characters (a 38-digit magnitude) is instead missed by
 * the provisioning rewrite in `@lunora/sql-store`, whose "already a key" test is
 * the 40-character width — it stays legacy, and an `eq` binding a key never
 * matches it.
 */
const decodeBigintSqlKey = (raw: string): bigint | undefined => {
    if (raw.length !== BIGINT_KEY_DIGITS + 1) {
        return undefined;
    }

    const sign = raw.slice(0, 1);
    const digits = raw.slice(1);

    if (!BIGINT_KEY_DIGITS_RE.test(digits)) {
        return undefined;
    }

    if (sign === NON_NEGATIVE) {
        return BigInt(digits);
    }

    return sign === NEGATIVE ? -BigInt(ninesComplement(digits)) : undefined;
};

/**
 * Hex digits one float64 key carries: the eight bytes of an IEEE-754 double,
 * four bits per digit. Fixed, so equal-width keys compare digit by digit.
 */
const FLOAT64_KEY_DIGITS = 16;

/** A key's shape: exactly {@link FLOAT64_KEY_DIGITS} lowercase hex digits, which is what `toString(16)` emits. */
const FLOAT64_KEY_RE = /^[\da-f]{16}$/u;

/* eslint-disable no-bitwise -- the IEEE-754 total-order transform IS bit manipulation; expressing it any other way would obscure the one thing these two functions do. */

/**
 * An order-preserving, exactly-reversible text key for a JS number — the
 * float64 twin of {@link bigintSqlKey}, and the transform the reactive layer's
 * range narrowing (`index-key-codec.ts`) already runs on.
 *
 * The standard total-order transform: view the double as big-endian bits; for
 * negatives (sign bit set) flip every bit so more-negative sorts lower, for
 * non-negatives flip only the sign bit so they all sort above the negatives.
 * Lexicographic order over the fixed 16-character hex output is then exactly
 * numeric order over the input, `-0` normalized to `0` so the two encode
 * identically — SQL compares them equal, so two keys would make an `eq` binding
 * miss half the rows it should match.
 *
 * Unlike {@link bigintSqlKey} there is no width to overflow, so every double is
 * representable — including `NaN` and `±Infinity`, which have exact bit patterns
 * and therefore exact round trips. IEEE's total order places `-Infinity` lowest,
 * `+Infinity` above every finite value, and `NaN` above that; `undefined`, not
 * being a number, never reaches here.
 */
const float64SqlKey = (value: number): string => {
    const view = new DataView(new ArrayBuffer(8));

    view.setFloat64(0, value === 0 ? 0 : value, false);

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

/**
 * Inverse of {@link float64SqlKey}, or `undefined` when `raw` is not a key.
 *
 * Lives beside the encoder for the reason {@link decodeBigintSqlKey} does: the
 * two halves share the width and the bit transform, and a decoder a file away
 * from them is how a change to either ships as a silent mis-read.
 *
 * The shape test is exact — 16 lowercase hex digits — but the encoding is
 * total over doubles, so unlike the bigint key there is no value the encoder
 * can produce that this refuses.
 */
const decodeFloat64SqlKey = (raw: string): number | undefined => {
    if (!FLOAT64_KEY_RE.test(raw)) {
        return undefined;
    }

    let high = Number.parseInt(raw.slice(0, 8), 16);
    let low = Number.parseInt(raw.slice(8), 16);

    if ((high & 0x80_00_00_00) === 0) {
        // The sign bit is clear, so the encoder took its negative branch and
        // flipped every bit. Flipping again is its own inverse.
        high = ~high >>> 0;
        low = ~low >>> 0;
    } else {
        high = (high ^ 0x80_00_00_00) >>> 0;
    }

    const view = new DataView(new ArrayBuffer(8));

    view.setUint32(0, high, false);
    view.setUint32(4, low, false);

    return view.getFloat64(0, false);
};

/* eslint-enable no-bitwise -- back to ordinary code. */

/**
 * The SQL-comparable scalar to store at `$.field` — and to bind against it — in
 * place of a value SQLite cannot compare in its wire-tagged form.
 * @returns the projected scalar, or `undefined` when the value already compares correctly and should be used as-is
 */
const sqlComparableProjection = (value: unknown): string | undefined => {
    if (typeof value === "bigint") {
        return bigintSqlKey(value);
    }

    if (value instanceof ArrayBuffer) {
        return toBase64(new Uint8Array(value));
    }

    return ArrayBuffer.isView(value) ? toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : undefined;
};

/**
 * Whether a column of this validator is stored as a projected sort key rather
 * than as its value — i.e. whether SQL reading `$.field` gets a comparison key
 * instead of something it can reduce or hand back.
 *
 * Reads the **effective** kind, so `v.optional(v.bigint())` answers the same as
 * `v.bigint()`. Dispatching on `validator.kind` directly is the mistake this
 * exists to stop: the projection keys off the runtime JS type, so an optional
 * column is projected exactly like its inner one while its declared kind says
 * `"optional"`, and every guard that missed that returned a confident wrong
 * number.
 */
const isProjectedKind = (validator: KindedValidator): boolean => {
    const kind = effectiveKind(validator);

    return kind === "bigint" || kind === "bytes";
};

/**
 * Whether a column of this validator **could** hold a projected value.
 *
 * Wider than {@link isProjectedKind} because a `v.any()` / `v.union()` /
 * `v.from()` field is declared without committing to a type and can perfectly
 * well hold a `bigint` or an `ArrayBuffer` — which the projection then projects,
 * on runtime type, exactly as it would a declared one. Used where missing a
 * field means missing data (the re-projection backfill's scan), not where
 * over-matching would be harmful.
 */
const mayHoldProjectedValue = (validator: KindedValidator): boolean => {
    const kind = effectiveKind(validator);

    return isProjectedKind(validator) || kind === "any" || kind === "union" || kind === "from";
};

// Both codec pairs are exported for `@lunora/sql-store`, which must produce a
// BYTE-IDENTICAL key on the `.global()` plane — the two planes are compared
// directly by a parity test, and a second copy of an order-preserving encoding
// is precisely the thing that drifts. `index-key-codec.ts` shares the float64
// half for the same reason: the reactive layer decides whether a written row
// falls inside a live query's range, and it can only get that right if its
// numeric order IS the stored one. The sign characters and the widths stay
// module-local: nothing outside needs them now that both halves live here.
export {
    BIGINT_KEY_DIGITS,
    bigintSqlKey,
    decodeBigintSqlKey,
    decodeFloat64SqlKey,
    float64SqlKey,
    isProjectedKind,
    mayHoldProjectedValue,
    sqlComparableProjection,
};
