/**
 * Bind values for mysql2's `query`, which interpolates them client-side: it
 * expands an array into a comma list and a plain object into `key = value`
 * pairs, so an array or object param would change the statement's shape instead
 * of binding one value. Each becomes its JSON text, which is what `execute`'s
 * binary protocol sent for them. Bytes, dates and scalars pass through: mysql2
 * escapes those as single literals.
 */
const toMysqlParams = (params: ReadonlyArray<unknown>): unknown[] =>
    params.map((value, index) => {
        if (value === undefined) {
            // `execute` rejected undefined; `query` would silently bind NULL.
            throw new TypeError(`@lunora/hyperdrive: MySQL bind parameter ${String(index + 1)} is undefined`);
        }

        if (value === null || typeof value !== "object" || value instanceof Date || ArrayBuffer.isView(value)) {
            return value;
        }

        return value instanceof ArrayBuffer ? new Uint8Array(value) : JSON.stringify(value);
    });

export default toMysqlParams;
