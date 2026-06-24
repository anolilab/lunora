/**
 * One `ctx.r2sql` access discovered lexically inside a `query(...)` or
 * `mutation(...)` handler body — the input the `r2sql_outside_action` lint
 * consumes. Produced by the codegen feeder, which walks each exported function's
 * handler with ts-morph and records reads of the R2 SQL `ctx.r2sql` surface
 * (`ctx.r2sql.query(...)`, `ctx.r2sql.from(...)`, …).
 *
 * R2 SQL queries Apache Iceberg tables over an **external** REST endpoint Lunora
 * does not own (there is no Workers binding): a `ctx.r2sql` call is a network
 * round-trip with a mutable result (non-deterministic, like `fetch`) and its
 * reads are invisible to Lunora live queries. It therefore belongs **only** in
 * `action(...)` handlers. Calls inside `action(...)` are intentionally **not**
 * recorded — actions are the escape hatch. Runtime callers don't supply this, so
 * the lint finds nothing there.
 */
export interface AdvisorR2sqlCall {
    /** The accessed `ctx.r2sql` surface, e.g. `ctx.r2sql.query` / `ctx.r2sql.from`. */
    callee: string;
    /** The exported function performing the access (e.g. `topPerRegion`). */
    exportName: string;
    /** Source file the access appears in (relative to the lunora dir, no extension). */
    file: string;
    /** Which procedure kind the access lives in — only `query`/`mutation` are flagged; actions are exempt. */
    kind: "mutation" | "query";
    /** 1-based line of the access, or `0` when unknown. */
    line: number;
}
