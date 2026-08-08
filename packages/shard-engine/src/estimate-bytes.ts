import { BIGINT_KEY_DIGITS } from "./sql-projection";

/** Characters a wire-tagged leaf costs beyond its payload — `["$lunora.wire$","bigint",""]` plus its key in the originals map. */
const WIRE_TAG_OVERHEAD = 40;

/**
 * Approximate serialized size of a value.
 *
 * `JSON.stringify` is what a row actually costs on disk and on the wire, and
 * both call sites stringify anyway, so this is representative without inventing
 * a second size model. Neither caller needs byte accuracy — the reactive cache
 * uses it to bound memory, the transaction meter to bound one request — so the
 * cheap estimate is the right trade.
 *
 * A value that cannot be serialized (a cycle, a function) returns `undefined`
 * rather than a size — there is no honest byte count for it, and each caller
 * decides what "cannot be sized" means on its own terms (the meter throws; the
 * cache declines to memoize).
 *
 * `bigint` and bytes are sized rather than refused: the row store stores both
 * (`encodeDocJson`), so a raw `JSON.stringify` would throw on a `v.bigint()`
 * column and hand the transaction meter its "not serializable" error for a
 * write that is perfectly valid.
 *
 * Both are charged for BOTH copies, because a top-level one is stored twice —
 * the SQL-comparable projection at `$.field` plus the wire-tagged original
 * parked under `__originals__`. Charging one copy undercounted a `bigint` column
 * by ~6x (measured: a single `10n` estimated 20 characters against a
 * 122-character blob; three of them, 28 against 268) and bytes by ~2x, enough to
 * let a write sail past `maxWrittenBytes` while the meter called it small. The
 * projection also means a `v.bigint()` column costs roughly **4x** its naive
 * JSON size on disk and a `v.bytes()` column roughly **2x** — worth knowing
 * before putting a wide money table in a 10 GB Durable Object.
 *
 * A NESTED `bigint`/bytes is charged the same way and so is mildly
 * over-counted, since only top-level fields are projected. Over-counting is the
 * safe direction for both callers.
 *
 * NOTE the unit: `String.length` counts UTF-16 code units, not UTF-8 bytes, so a
 * CJK- or emoji-heavy document costs up to ~3x more on the wire than it is
 * charged here. Both callers' caps are set well below the resource they protect,
 * which absorbs the skew — but a caller needing true byte accuracy must not use
 * this.
 */
const estimateBytes = (value: unknown): number | undefined => {
    let extraWidth = 0;

    const replacer = (_key: string, raw: unknown): unknown => {
        if (typeof raw === "bigint") {
            // The zero-padded projection plus the tagged original's wrapper; the
            // digits themselves come back through the returned string.
            extraWidth += BIGINT_KEY_DIGITS + 1 + WIRE_TAG_OVERHEAD;

            return raw.toString();
        }

        if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
            // Two base64 copies plus the wrapper, measured out-of-band rather
            // than by encoding the blob twice just to read `.length` — that
            // would allocate ~8/3 of it on every write, to throw it away.
            extraWidth += 2 * Math.ceil(raw.byteLength / 3) * 4 + WIRE_TAG_OVERHEAD;

            return "";
        }

        return raw;
    };

    try {
        // `JSON.stringify` is TYPED as returning `string`, but genuinely returns
        // `undefined` for `undefined`, functions, and symbols — so the result
        // has to be widened before it can be safely measured.
        const encoded = JSON.stringify(value, replacer) as string | undefined;

        return (encoded === undefined ? 0 : encoded.length) + extraWidth;
    } catch {
        return undefined;
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through the engine barrel uniform (same rationale as `serialize-sql.ts`).
export { estimateBytes };
