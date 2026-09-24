/**
 * `SelectBuilder` — the chainable, typed `SELECT` for R2 SQL over one Iceberg
 * table, with first-class support for the 2026-06-21 features (`DISTINCT` /
 * `DISTINCT ON`, window-function `QUALIFY`, set operations) plus the everyday
 * clauses (`WHERE`, joins, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`).
 *
 * Every clause method returns `this`; `.toSQL()` renders the inspectable
 * statement and `.run()` executes it. Values flow through {@link
 * import("./sql").lit | lit}/`sql`, so user input is always escaped; raw
 * column/expression strings are taken as trusted SQL.
 */

import type { OrderTerm } from "./order";
import { renderOrderTerm } from "./order";
import type { Condition, Queryable, QueryExecutor } from "./query";
import SetOperation from "./set-operation";
import type { Sql } from "./sql";
import { assertLimit, lit, tableRef, toText } from "./sql";
import type { R2SqlResult } from "./types";

const JOIN_KEYWORDS = {
    cross: "CROSS JOIN",
    full: "FULL OUTER JOIN",
    inner: "INNER JOIN",
    left: "LEFT JOIN",
    right: "RIGHT JOIN",
} as const;

/**
 * `AND`-join conditions, wrapping each one in parentheses.
 *
 * `AND` binds tighter than `OR`, so a bare ` AND ` join re-parses a fragment
 * that carries its own `OR` — `.where("a OR b").where("c")` became
 * `a OR (b AND c)`, a filter that matches rows the caller excluded. The builder
 * takes conditions as opaque text (a `sql` fragment or a raw string), so it
 * cannot see the operator and has to bracket unconditionally.
 *
 * A single condition renders bare: nothing can rebind it, and the parentheses
 * would only be noise in the SQL a caller reads back.
 */
const conjoin = (conditions: ReadonlyArray<string>): string =>
    conditions.length > 1 ? conditions.map((condition) => `(${condition})`).join(" AND ") : conditions.join(" AND ");

type JoinKind = keyof typeof JOIN_KEYWORDS;

interface JoinClause {
    kind: JoinKind;
    on?: Condition;
    table: string;
}

/**
 * A fluent `SELECT` over one Iceberg table (`namespace.table`), generic over the
 * caller-declared `Row` result type.
 */
export default class SelectBuilder<Row = Record<string, unknown>> implements Queryable<Row> {
    private readonly exec: QueryExecutor;

    private readonly table: string;

    private readonly selectItems: string[] = [];

    private distinctFlag = false;

    private readonly distinctOnItems: string[] = [];

    private readonly joins: JoinClause[] = [];

    private readonly whereConditions: string[] = [];

    private readonly groupByItems: string[] = [];

    private readonly havingConditions: string[] = [];

    private qualifyCondition?: string;

    private readonly orderByItems: string[] = [];

    private limitValue?: number;

    public constructor(exec: QueryExecutor, table: string) {
        this.exec = exec;
        // Validate here (not only at the `ctx.r2sql.from` entry) so a directly
        // constructed builder can't splice an unchecked table name into `FROM`.
        // `tableRef` allows an optional `[AS] alias` (e.g. `s.zones z`).
        this.table = tableRef(table);
    }

    /** The `SELECT` list. Omit/empty for `SELECT *`. Items are columns, expressions, or aliased window fragments (`fn.rowNumber().over(...).as("rk")`). */
    public select(...items: (Sql | string)[]): this {
        this.selectItems.push(...items.map((item) => toText(item)));

        return this;
    }

    /** `SELECT DISTINCT` — unique rows. */
    public distinct(): this {
        this.distinctFlag = true;

        return this;
    }

    /** `DISTINCT ON (cols)` — the first row per distinct combination, ordered by {@link orderBy}. */
    public distinctOn(...columns: (Sql | string)[]): this {
        this.distinctOnItems.push(...columns.map((column) => toText(column)));

        return this;
    }

    /** `INNER JOIN table ON condition`. */
    public innerJoin(table: string, on: Condition): this {
        return this.addJoin("inner", table, on);
    }

    /** `LEFT JOIN table ON condition`. */
    public leftJoin(table: string, on: Condition): this {
        return this.addJoin("left", table, on);
    }

    /** `RIGHT JOIN table ON condition`. */
    public rightJoin(table: string, on: Condition): this {
        return this.addJoin("right", table, on);
    }

    /** `FULL OUTER JOIN table ON condition`. */
    public fullJoin(table: string, on: Condition): this {
        return this.addJoin("full", table, on);
    }

    /** `CROSS JOIN table` (no `ON`). */
    public crossJoin(table: string): this {
        return this.addJoin("cross", table);
    }

    /** Add `WHERE` condition(s). Multiple calls (and multiple args) are `AND`-ed, each parenthesised. Bind values with the `sql` tag. */
    public where(...conditions: Condition[]): this {
        this.whereConditions.push(...conditions.map((condition) => toText(condition)));

        return this;
    }

    /** `GROUP BY` column(s)/expression(s). */
    public groupBy(...columns: (Sql | string)[]): this {
        this.groupByItems.push(...columns.map((column) => toText(column)));

        return this;
    }

    /** Add `HAVING` condition(s) over aggregates; multiple are `AND`-ed, each parenthesised. */
    public having(...conditions: Condition[]): this {
        this.havingConditions.push(...conditions.map((condition) => toText(condition)));

        return this;
    }

    /**
     * `QUALIFY` — filter on a window function without a subquery, e.g.
     * `.qualify(fn.rowNumber().over({ partitionBy: "region", orderBy: desc("total") }).lte(3))`.
     */
    public qualify(condition: Condition): this {
        this.qualifyCondition = toText(condition);

        return this;
    }

    /** `ORDER BY` term(s) — bare strings (ASC) or {@link import("./order").asc | asc}/{@link import("./order").desc | desc} tags. */
    public orderBy(...terms: OrderTerm[]): this {
        this.orderByItems.push(...terms.map((term) => renderOrderTerm(term)));

        return this;
    }

    /** `LIMIT n` (R2 SQL: 1–10,000, default 500). */
    public limit(n: number): this {
        assertLimit(n);
        this.limitValue = n;

        return this;
    }

    /** Re-type the result rows without changing the query (the builder carries no schema of its own). */
    public returns<NextRow>(): SelectBuilder<NextRow> {
        return this as unknown as SelectBuilder<NextRow>;
    }

    /** `this UNION other` — all rows from both, duplicates removed. */
    public union(other: Queryable<unknown>): SetOperation<Row> {
        return this.setOperation("UNION", other);
    }

    /** `this UNION ALL other` — all rows from both, duplicates kept. */
    public unionAll(other: Queryable<unknown>): SetOperation<Row> {
        return this.setOperation("UNION ALL", other);
    }

    /** `this INTERSECT other` — rows present in both. */
    public intersect(other: Queryable<unknown>): SetOperation<Row> {
        return this.setOperation("INTERSECT", other);
    }

    /** `this EXCEPT other` — rows in `this` but not `other`. */
    public except(other: Queryable<unknown>): SetOperation<Row> {
        return this.setOperation("EXCEPT", other);
    }

    /** True when this query carries its own `ORDER BY`/`LIMIT` — so a set operation must parenthesise it. */
    public get needsWrapForSetOperation(): boolean {
        return this.orderByItems.length > 0 || this.limitValue !== undefined;
    }

    /** Render the `SELECT` statement (no trailing semicolon). */
    public toSQL(): string {
        const parts = [`${this.renderHead()} ${this.selectItems.length > 0 ? this.selectItems.join(", ") : "*"}`, `FROM ${this.table}`];

        for (const join of this.joins) {
            parts.push(join.on === undefined ? `${JOIN_KEYWORDS[join.kind]} ${join.table}` : `${JOIN_KEYWORDS[join.kind]} ${join.table} ON ${toText(join.on)}`);
        }

        if (this.whereConditions.length > 0) {
            parts.push(`WHERE ${conjoin(this.whereConditions)}`);
        }

        if (this.groupByItems.length > 0) {
            parts.push(`GROUP BY ${this.groupByItems.join(", ")}`);
        }

        if (this.havingConditions.length > 0) {
            parts.push(`HAVING ${conjoin(this.havingConditions)}`);
        }

        if (this.qualifyCondition !== undefined) {
            parts.push(`QUALIFY ${this.qualifyCondition}`);
        }

        if (this.orderByItems.length > 0) {
            parts.push(`ORDER BY ${this.orderByItems.join(", ")}`);
        }

        if (this.limitValue !== undefined) {
            parts.push(`LIMIT ${lit(this.limitValue)}`);
        }

        return parts.join(" ");
    }

    /** Execute the query and return the typed result. */
    public async run(): Promise<R2SqlResult<Row>> {
        return this.exec(this.toSQL()) as Promise<R2SqlResult<Row>>;
    }

    /** The `SELECT [DISTINCT [ON (...)]]` head. */
    private renderHead(): string {
        if (this.distinctOnItems.length > 0) {
            return `SELECT DISTINCT ON (${this.distinctOnItems.join(", ")})`;
        }

        return this.distinctFlag ? "SELECT DISTINCT" : "SELECT";
    }

    private addJoin(kind: JoinKind, table: string, on?: Condition): this {
        // Join tables are spliced into the rendered SQL (R2 SQL has no parameter
        // binding), so allowlist the reference (`table [AS] alias`) — the `on`
        // condition is already a value-escaping `sql`/`lit` fragment.
        this.joins.push({ kind, on, table: tableRef(table) });

        return this;
    }

    private setOperation(operator: string, other: Queryable<unknown>): SetOperation<Row> {
        return new SetOperation<Row>(this.exec, [{ query: this }, { operator, query: other }]);
    }
}
