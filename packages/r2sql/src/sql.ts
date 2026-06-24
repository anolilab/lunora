/**
 * Safe SQL composition for R2 SQL.
 *
 * R2 SQL's REST endpoint takes a single `query` string and has **no parameter
 * binding** — every value is inlined into the statement text. That makes naive
 * string interpolation an injection sink. {@link sql} is the safe alternative: a
 * tagged template that escapes each interpolated JS value into a SQL literal via
 * {@link lit}, while letting you splice already-trusted fragments with
 * {@link raw}. The result is a {@link Sql} object the client and builder accept
 * anywhere a query/condition is expected.
 *
 * ```ts
 * const region = "North'; DROP TABLE x; --";
 * sql`SELECT * FROM s.orders WHERE region = ${region} LIMIT 10`;
 * // SELECT * FROM s.orders WHERE region = 'North''; DROP TABLE x; --' LIMIT 10
 * ```
 */

/** Escape a string as a single-quoted SQL literal (doubling embedded single quotes). */
const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * A composed SQL fragment. Carries the finished `text`; `toString()` returns it
 * so a fragment can be dropped straight into a template or `String(...)`.
 */
export class Sql {
    public readonly text: string;

    public constructor(text: string) {
        this.text = text;
    }

    public toString(): string {
        return this.text;
    }
}

/** True when `value` is a {@link Sql} fragment (an already-trusted, pre-escaped span). */
export const isSql = (value: unknown): value is Sql => value instanceof Sql;

/**
 * Wrap an already-trusted string as a {@link Sql} fragment so {@link sql}
 * splices it **verbatim** (no escaping). Use ONLY for SQL you constructed
 * yourself (identifiers, keywords, sub-fragments) — never for user input.
 */
export const raw = (text: string): Sql => new Sql(text);

/** Resolve a `string | Sql` to its raw text. A bare string is taken as trusted SQL (callers pass identifiers/fragments here). */
export const toText = (value: Sql | string): string => (isSql(value) ? value.text : value);

/**
 * Render a JS value as an R2 SQL literal:
 *
 * - `null` / `undefined` → `NULL`
 * - `boolean` → `true` / `false`
 * - finite `number` / `bigint` → the numeric text (non-finite throws — `NaN`/`Infinity` have no SQL literal)
 * - `Date` → an RFC3339 string literal (R2 SQL's `timestamp` form)
 * - `string` → a single-quoted, escaped literal
 * - `Array` → a parenthesised, comma-separated list of literals (for `IN (...)`)
 *
 * Anything else (object, symbol, function) throws — there is no safe SQL literal
 * for it, and silently coercing would risk a malformed or injectable statement.
 */
export const lit = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "NULL";
    }

    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError(`r2sql: cannot inline a non-finite number (${String(value)}) as a SQL literal.`);
        }

        return String(value);
    }

    if (typeof value === "string") {
        return quoteString(value);
    }

    if (value instanceof Date) {
        return quoteString(value.toISOString());
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            // An empty array would render `IN ()`, which R2 SQL rejects. Fail
            // loudly here rather than emit a statement the engine errors on.
            throw new TypeError("r2sql: cannot inline an empty array — `IN ()` is not valid SQL. Guard the empty case before building the query.");
        }

        return `(${value.map((element) => lit(element)).join(", ")})`;
    }

    throw new TypeError(`r2sql: cannot inline a value of type ${typeof value} as a SQL literal. Wrap trusted SQL with raw(), or pass a primitive/Date/array.`);
};

/**
 * Tagged template producing a safe {@link Sql} fragment. Each interpolation is
 * escaped with {@link lit} unless it is already a {@link Sql} (spliced
 * verbatim), so user values can never break out of their literal.
 */
export const sql = (strings: TemplateStringsArray, ...values: unknown[]): Sql => {
    let out = strings[0] ?? "";

    for (const [index, value] of values.entries()) {
        out += isSql(value) ? value.text : lit(value);
        out += strings[index + 1] ?? "";
    }

    return new Sql(out);
};

/** Join SQL fragments/strings with `separator` into one {@link Sql} (e.g. `AND`-ed conditions). */
export const joinSql = (parts: ReadonlyArray<Sql | string>, separator: string): Sql => new Sql(parts.map((part) => toText(part)).join(separator));
