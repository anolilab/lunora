/**
 * `SetOperation` — a composition of queries via `UNION` / `UNION ALL` /
 * `INTERSECT` / `EXCEPT`, with an optional single `ORDER BY` / `LIMIT` over the
 * combined result.
 */

import type { OrderTerm } from "./order";
import { renderOrderTerm } from "./order";
import type { Queryable, QueryExecutor } from "./query";
import { lit } from "./sql";
import type { R2SqlResult } from "./types";

/** One member of a {@link SetOperation}: the leading query has no operator; each subsequent one carries the operator that joins it. */
interface SetMember {
    operator?: string;
    query: Queryable<unknown>;
}

/** Render a set-operation member, parenthesising one that carries its own `ORDER BY`/`LIMIT` (R2 SQL rejects a bare `LIMIT` before a set operator). */
const renderMember = (query: Queryable<unknown>): string => {
    const text = query.toSQL();

    return query.needsWrapForSetOperation === true ? `(${text})` : text;
};

/**
 * A composition of queries via set operations. Chain more operations, or apply a
 * single `ORDER BY` / `LIMIT` to the combined result.
 */
export default class SetOperation<Row = Record<string, unknown>> implements Queryable<Row> {
    /**
     * Always `true`: a nested set operation must be parenthesised when it is a
     * member of another set operation, or mixed operators mis-associate — e.g.
     * `a.union(b.except(c))` must render `a UNION (b EXCEPT c)`, not the flat
     * `a UNION b EXCEPT c`.
     */
    public readonly needsWrapForSetOperation = true;

    private readonly exec: QueryExecutor;

    private readonly members: SetMember[];

    private readonly orderByItems: string[] = [];

    private limitValue?: number;

    public constructor(exec: QueryExecutor, members: SetMember[]) {
        this.exec = exec;
        this.members = members;
    }

    /** Append `UNION other`. */
    public union(other: Queryable<unknown>): this {
        return this.add("UNION", other);
    }

    /** Append `UNION ALL other`. */
    public unionAll(other: Queryable<unknown>): this {
        return this.add("UNION ALL", other);
    }

    /** Append `INTERSECT other`. */
    public intersect(other: Queryable<unknown>): this {
        return this.add("INTERSECT", other);
    }

    /** Append `EXCEPT other`. */
    public except(other: Queryable<unknown>): this {
        return this.add("EXCEPT", other);
    }

    /** `ORDER BY` applied to the combined result. */
    public orderBy(...terms: OrderTerm[]): this {
        this.orderByItems.push(...terms.map((term) => renderOrderTerm(term)));

        return this;
    }

    /** `LIMIT` applied to the combined result. */
    public limit(n: number): this {
        this.limitValue = n;

        return this;
    }

    /** Re-type the combined result rows. */
    public returns<NextRow>(): SetOperation<NextRow> {
        return this as unknown as SetOperation<NextRow>;
    }

    /** Render the combined statement. */
    public toSQL(): string {
        const parts = this.members.map((member) => {
            const text = renderMember(member.query);

            return member.operator === undefined ? text : `${member.operator} ${text}`;
        });

        const combined = parts.join(" ");
        const tail: string[] = [];

        if (this.orderByItems.length > 0) {
            tail.push(`ORDER BY ${this.orderByItems.join(", ")}`);
        }

        if (this.limitValue !== undefined) {
            tail.push(`LIMIT ${lit(this.limitValue)}`);
        }

        return tail.length > 0 ? `${combined} ${tail.join(" ")}` : combined;
    }

    /** Execute the combined query and return the typed result. */
    public async run(): Promise<R2SqlResult<Row>> {
        return this.exec(this.toSQL()) as Promise<R2SqlResult<Row>>;
    }

    private add(operator: string, other: Queryable<unknown>): this {
        this.members.push({ operator, query: other });

        return this;
    }
}
