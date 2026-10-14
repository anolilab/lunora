/**
 * A windowed expression — `FUNC(args) OVER (...)`. Produced by {@link
 * import("./window").WindowFunction.over | WindowFunction.over}; alias it into a
 * `SELECT` with {@link WindowExpression.as | .as}, or turn it into a
 * `QUALIFY`/`WHERE` condition with the comparison helpers.
 */

import { lit, Sql } from "./sql";

/** Matches a plain SQL identifier (letters, digits, underscore, `$`; not starting with a digit). */
const IDENTIFIER = /^[A-Z_][\w$]*$/i;

/** Reject anything that isn't a plain SQL identifier, so an alias can never inject. */
const assertIdent = (name: string): string => {
    if (!IDENTIFIER.test(name)) {
        throw new TypeError(`r2sql: invalid identifier ${JSON.stringify(name)} — expected a simple SQL name (letters, digits, underscore).`);
    }

    return name;
};

/**
 * A windowed expression. Extends {@link Sql}, so it is usable anywhere a raw
 * fragment is; `.as(alias)` makes a `SELECT` item, and the comparison helpers
 * (`.lte`, `.gt`, `.between`, …) make `QUALIFY` conditions.
 */
export default class WindowExpression extends Sql {
    /** Alias the expression — `... AS alias` — for use in a `SELECT` list. */
    public as(alias: string): Sql {
        return new Sql(`${this.text} AS ${assertIdent(alias)}`);
    }

    /** `expr BETWEEN low AND high`. */
    public between(low: unknown, high: unknown): Sql {
        return new Sql(`${this.text} BETWEEN ${lit(low)} AND ${lit(high)}`);
    }

    /** `expr = value`. */
    public eq(value: unknown): Sql {
        return this.compare("=", value);
    }

    /** `expr > value`. */
    public gt(value: unknown): Sql {
        return this.compare(">", value);
    }

    /** `expr >= value`. */
    public gte(value: unknown): Sql {
        return this.compare(">=", value);
    }

    /** `expr < value`. */
    public lt(value: unknown): Sql {
        return this.compare("<", value);
    }

    /** `expr <= value`. */
    public lte(value: unknown): Sql {
        return this.compare("<=", value);
    }

    private compare(operator: string, value: unknown): Sql {
        return new Sql(`${this.text} ${operator} ${lit(value)}`);
    }
}
