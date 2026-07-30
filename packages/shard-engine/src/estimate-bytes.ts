/**
 * Approximate serialized size of a value.
 *
 * `JSON.stringify` is what a row actually costs on disk and on the wire, and
 * both call sites stringify anyway, so this is representative without inventing
 * a second size model. Neither caller needs byte accuracy — the reactive cache
 * uses it to bound memory, the transaction meter to bound one request — so the
 * cheap estimate is the right trade.
 *
 * A value that cannot be serialized (a cycle) is charged `fallback`, so the
 * caller fails on its own terms rather than silently costing nothing.
 */
const estimateBytes = (value: unknown, fallback: number): number => {
    try {
        // `JSON.stringify` is TYPED as returning `string`, but genuinely returns
        // `undefined` for `undefined`, functions, and symbols — so the result
        // has to be widened before it can be safely measured.
        const encoded = JSON.stringify(value) as string | undefined;

        return encoded === undefined ? 0 : encoded.length;
    } catch {
        return fallback;
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export keeps the re-export chain through the engine barrel uniform (same rationale as `serialize-sql.ts`).
export { estimateBytes };
