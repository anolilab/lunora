/**
 * Approximate serialized size of a value.
 *
 * `JSON.stringify` is what a row actually costs on disk and on the wire, and
 * both call sites stringify anyway, so this is representative without inventing
 * a second size model. Neither caller needs byte accuracy — the reactive cache
 * uses it to bound memory, the transaction meter to bound one request — so the
 * cheap estimate is the right trade.
 *
 * A value that cannot be serialized (a cycle, a function, a bigint outside a
 * codec) returns `undefined` rather than a size — there is no honest byte count
 * for it, and each caller decides what "cannot be sized" means on its own terms
 * (the meter throws; the cache declines to memoize).
 *
 * NOTE the unit: `String.length` counts UTF-16 code units, not UTF-8 bytes, so a
 * CJK- or emoji-heavy document costs up to ~3x more on the wire than it is
 * charged here. Both callers' caps are set well below the resource they protect,
 * which absorbs the skew — but a caller needing true byte accuracy must not use
 * this.
 */
const estimateBytes = (value: unknown): number | undefined => {
    try {
        // `JSON.stringify` is TYPED as returning `string`, but genuinely returns
        // `undefined` for `undefined`, functions, and symbols — so the result
        // has to be widened before it can be safely measured.
        const encoded = JSON.stringify(value) as string | undefined;

        return encoded === undefined ? 0 : encoded.length;
    } catch {
        return undefined;
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through the engine barrel uniform (same rationale as `serialize-sql.ts`).
export { estimateBytes };
