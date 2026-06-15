/**
 * One `ctx.sql` access discovered lexically inside a `query(...)` or
 * `mutation(...)` handler body — the input the `hyperdrive_outside_action` lint
 * consumes. Produced by the codegen feeder, which walks each exported function's
 * handler with ts-morph and records reads of the Hyperdrive `ctx.sql` surface
 * (`ctx.sql(...)`, `ctx.sql.query(...)`).
 *
 * Hyperdrive points at an **external** database Cirrus does not own: a `ctx.sql`
 * call is a network round-trip with a mutable result (non-deterministic, like
 * `fetch`) and its writes are invisible to Cirrus live queries. It therefore
 * belongs **only** in `action(...)` handlers. Calls inside `action(...)` are
 * intentionally **not** recorded — actions are the escape hatch. Runtime callers
 * don't supply this, so the lint finds nothing there.
 */
export interface AdvisorHyperdriveCall {
    /** The accessed `ctx.sql` surface, e.g. `ctx.sql.query` / `ctx.sql`. */
    callee: string;
    /** The exported function performing the access (e.g. `listCustomers`). */
    exportName: string;
    /** Source file the access appears in (relative to the cirrus dir, no extension). */
    file: string;
    /** Which procedure kind the access lives in — only `query`/`mutation` are flagged; actions are exempt. */
    kind: "mutation" | "query";
    /** 1-based line of the access, or `0` when unknown. */
    line: number;
}
