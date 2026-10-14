/**
 * First-class window functions for R2 SQL — the headline of the 2026-06-21
 * release (`ROW_NUMBER`, `RANK`, `LAG`, running aggregates, …) plus the
 * `QUALIFY` filter that goes with them.
 *
 * The shape mirrors SQL: build a function (`fn.rowNumber()`), attach a window
 * (`.over({ partitionBy, orderBy, frame })`), then either alias it into a
 * `SELECT` (`.as("rank")`) or compare it for `QUALIFY` (`.lte(3)`). Every step
 * produces a {@link Sql} fragment, so the output is inspectable and composes
 * with the builder and the {@link import("./sql").sql | sql} tag.
 *
 * ```ts
 * fn.rowNumber()
 *   .over({ partitionBy: "region", orderBy: desc("total") })
 *   .as("rank_in_region");
 * // ROW_NUMBER() OVER (PARTITION BY region ORDER BY total DESC) AS rank_in_region
 * ```
 */

import type { OrderTerm } from "./order";
import { renderOrderTerm } from "./order";
import type { Sql } from "./sql";
import { lit, toText } from "./sql";
import WindowExpression from "./window-expression";

/** The `OVER (...)` window specification. */
interface OverSpec {
    /**
     * A raw frame clause, e.g. `"ROWS BETWEEN 2 PRECEDING AND CURRENT ROW"`.
     * Spliced verbatim — it is keyword-only SQL, not a value.
     */
    frame?: string;
    /** `ORDER BY` term(s) within the window. */
    orderBy?: OrderTerm | OrderTerm[];
    /** `PARTITION BY` column(s)/expression(s). */
    partitionBy?: Sql | string | (Sql | string)[];
}

const toArray = <T>(value: T | T[] | undefined): T[] => {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
};

/** Render an {@link OverSpec} to the parenthesised `OVER (...)` body. */
const renderOver = (spec: OverSpec): string => {
    const clauses: string[] = [];
    const partitions = toArray(spec.partitionBy).map((part) => toText(part));

    if (partitions.length > 0) {
        clauses.push(`PARTITION BY ${partitions.join(", ")}`);
    }

    const orders = toArray(spec.orderBy).map((order) => renderOrderTerm(order));

    if (orders.length > 0) {
        clauses.push(`ORDER BY ${orders.join(", ")}`);
    }

    if (spec.frame !== undefined && spec.frame.length > 0) {
        clauses.push(spec.frame);
    }

    return `OVER (${clauses.join(" ")})`;
};

const offsetArguments = (column: Sql | string, offset?: number, fallback?: unknown): string => {
    const parts = [toText(column)];

    if (offset !== undefined) {
        parts.push(lit(offset));
    }

    if (fallback !== undefined) {
        parts.push(lit(fallback));
    }

    return parts.join(", ");
};

/**
 * A window function awaiting its `OVER (...)`. Call {@link WindowFunction.over |
 * .over} to bind a window and get a {@link WindowExpression}.
 */
class WindowFunction {
    private readonly callText: string;

    public constructor(callText: string) {
        this.callText = callText;
    }

    /** Attach the window frame, yielding a {@link WindowExpression}. */
    public over(spec: OverSpec = {}): WindowExpression {
        return new WindowExpression(`${this.callText} ${renderOver(spec)}`);
    }
}

const windowFunction = (callText: string): WindowFunction => new WindowFunction(callText);

/**
 * Window-function builders. Each returns a {@link WindowFunction}; chain
 * `.over(...)` to bind the window.
 *
 * Ranking: `rowNumber`, `rank`, `denseRank`, `percentRank`, `cumeDist`,
 * `ntile`. Offset/value: `lag`, `lead`, `firstValue`, `lastValue`, `nthValue`.
 * Aggregates used as windows: `sum`, `avg`, `count`, `min`, `max`.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- `fn` is the deliberate public DX name (fn.rowNumber(), fn.sum(...)).
const fn = {
    /** `AVG(column) OVER (...)`. */
    avg: (column: Sql | string): WindowFunction => windowFunction(`AVG(${toText(column)})`),
    /** `COUNT(column) OVER (...)` — omit the column for `COUNT(*)`. */
    count: (column?: Sql | string): WindowFunction => windowFunction(`COUNT(${column === undefined ? "*" : toText(column)})`),
    /** `CUME_DIST() OVER (...)`. */
    cumeDist: (): WindowFunction => windowFunction("CUME_DIST()"),
    /** `DENSE_RANK() OVER (...)`. */
    denseRank: (): WindowFunction => windowFunction("DENSE_RANK()"),
    /** `FIRST_VALUE(column) OVER (...)`. */
    firstValue: (column: Sql | string): WindowFunction => windowFunction(`FIRST_VALUE(${toText(column)})`),
    /** `LAG(column[, offset[, default]]) OVER (...)`. */
    lag: (column: Sql | string, offset?: number, fallback?: unknown): WindowFunction => windowFunction(`LAG(${offsetArguments(column, offset, fallback)})`),
    /** `LAST_VALUE(column) OVER (...)`. */
    lastValue: (column: Sql | string): WindowFunction => windowFunction(`LAST_VALUE(${toText(column)})`),
    /** `LEAD(column[, offset[, default]]) OVER (...)`. */
    lead: (column: Sql | string, offset?: number, fallback?: unknown): WindowFunction => windowFunction(`LEAD(${offsetArguments(column, offset, fallback)})`),
    /** `MAX(column) OVER (...)`. */
    max: (column: Sql | string): WindowFunction => windowFunction(`MAX(${toText(column)})`),
    /** `MIN(column) OVER (...)`. */
    min: (column: Sql | string): WindowFunction => windowFunction(`MIN(${toText(column)})`),
    /** `NTH_VALUE(column, n) OVER (...)`. */
    nthValue: (column: Sql | string, n: number): WindowFunction => windowFunction(`NTH_VALUE(${toText(column)}, ${lit(n)})`),
    /** `NTILE(buckets) OVER (...)`. */
    ntile: (buckets: number): WindowFunction => windowFunction(`NTILE(${lit(buckets)})`),
    /** `PERCENT_RANK() OVER (...)`. */
    percentRank: (): WindowFunction => windowFunction("PERCENT_RANK()"),
    /** `RANK() OVER (...)`. */
    rank: (): WindowFunction => windowFunction("RANK()"),
    /** `ROW_NUMBER() OVER (...)`. */
    rowNumber: (): WindowFunction => windowFunction("ROW_NUMBER()"),
    /** `SUM(column) OVER (...)`. */
    sum: (column: Sql | string): WindowFunction => windowFunction(`SUM(${toText(column)})`),
};

export { fn, WindowFunction };
export type { OverSpec };
