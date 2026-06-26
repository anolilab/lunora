/**
 * Shared contracts for the query builder, factored out so {@link
 * import("./builder").SelectBuilder | SelectBuilder} and {@link
 * import("./set-operation").SetOperation | SetOperation} can reference them
 * without importing each other (no cycle).
 */

import type { Sql } from "./sql";
import type { R2SqlResult } from "./types";

/**
 * Executes a finished SQL string against R2 SQL and returns the parsed result.
 * Deliberately non-generic (the row type is a caller-side concern) — the typed
 * `run()` / `query()` boundaries cast the open result to the declared row.
 */
export type QueryExecutor = (statement: string) => Promise<R2SqlResult>;

/** Anything that compiles to a statement and can run — a {@link import("./builder").SelectBuilder | SelectBuilder} or {@link import("./set-operation").SetOperation | SetOperation}. */
export interface Queryable<Row = Record<string, unknown>> {
    /**
     * True when this query carries its own `ORDER BY`/`LIMIT`, so a set
     * operation must parenthesise it (R2 SQL rejects a bare `LIMIT` before a set
     * operator). Read structurally by the set-operation renderer to avoid an
     * import cycle.
     */
    readonly needsWrapForSetOperation?: boolean;
    run: () => Promise<R2SqlResult<Row>>;
    toSQL: () => string;
}

/** A `WHERE`/`HAVING`/`QUALIFY`/`ON` condition: trusted SQL text or a {@link Sql} fragment (use the `sql` tag to bind values safely). */
export type Condition = Sql | string;
