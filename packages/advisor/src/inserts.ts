/**
 * One `ctx.db.insert("table", …)` write discovered in a function body — the
 * write-side analog of `AdvisorQueryRead`, the input the
 * `table_without_insert` lint consumes. Produced by the codegen feeder (which
 * attributes each insert to the exported function performing it); runtime callers
 * don't supply it, so the lint simply finds nothing there.
 */
export interface AdvisorInsertWrite {
    /** The exported function performing the insert (e.g. `send`). */
    exportName: string;
    /** Source file the insert appears in (relative to the cirrus dir, no extension). */
    file: string;
    /** 1-based line of the `insert(...)` call, or `0` when unknown. */
    line: number;
    /** The inserted table; empty when the `insert(...)` argument is not a string literal. */
    table: string;
}
