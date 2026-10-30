/**
 * A string as a quoted literal that mysql2 inlines verbatim through
 * `toSqlString`. mysql2's own escaping writes `'` as `\'`, which ends the
 * literal on a server whose `sql_mode` has `NO_BACKSLASH_ESCAPES` and lets the
 * value inject SQL. A doubled `''` is a quote under every mode, so the value
 * can never leave its literal; a backslash still has to be doubled for the
 * default mode, which is why that mode stays required for backslashes to
 * round-trip. A hex `_utf8mb4 X'…'` literal would be mode-proof but takes the
 * charset's default collation instead of the connection's, and comparing it
 * with a plain `'…'` literal then fails with "Illegal mix of collations".
 */
const stringLiteral = (text: string): { toSqlString: () => string; toString: () => string } => {
    // `toString` is what mysql2's `??` identifier escaper reads; it never calls `toSqlString`.
    return { toSqlString: () => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`, toString: () => text };
};

/**
 * Bind values for mysql2's `query`, which interpolates them client-side: it
 * expands an array into a comma list and a plain object into `key = value`
 * pairs, so an array or object param would change the statement's shape instead
 * of binding one value. Each becomes its JSON text, which is what `execute`'s
 * binary protocol sent for them. Strings are quoted by {@link stringLiteral};
 * bytes, dates and other scalars pass through, since mysql2 renders those
 * without quote or backslash escapes.
 */
const toMysqlParams = (params: ReadonlyArray<unknown>): unknown[] =>
    params.map((value, index) => {
        if (value === undefined) {
            // `execute` rejected undefined; `query` would silently bind NULL.
            throw new TypeError(`@lunora/hyperdrive: MySQL bind parameter ${String(index + 1)} is undefined`);
        }

        if (typeof value === "string") {
            return stringLiteral(value);
        }

        if (value === null || typeof value !== "object" || value instanceof Date || ArrayBuffer.isView(value)) {
            return value;
        }

        return value instanceof ArrayBuffer ? new Uint8Array(value) : stringLiteral(JSON.stringify(value));
    });

export default toMysqlParams;
