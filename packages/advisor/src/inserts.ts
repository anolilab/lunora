/**
 * One `ctx.db.insert("table", …)` write discovered in a function body — the
 * write-side analog of `AdvisorQueryRead`, the input the
 * `table_without_insert` lint consumes. Produced by the codegen feeder (which
 * attributes each insert to the exported function performing it); runtime callers
 * don't supply it, so the lint simply finds nothing there.
 */
export interface AdvisorInsertWrite {
    /**
     * The exported function performing the insert (e.g. `send`). A write inside a
     * same-file helper is attributed to every export that calls the helper; `""`
     * when no export does (see {@link AdvisorInsertWrite.helper}).
     */
    exportName: string;
    /** Source file the insert appears in (relative to the lunora dir, no extension). */
    file: string;
    /** Set only when `exportName` is `""`: the non-exported helper the write sits in, which no export calls. */
    helper?: string;
    /** 1-based line of the `insert(...)` call, or `0` when unknown. */
    line: number;
    /** The inserted table; empty when the `insert(...)` argument is not a string literal. */
    table: string;
}

/**
 * Any other table write the codegen feeder attributed: a by-id `patch` /
 * `replace` / `delete` (table read off the id's `Id<"table">` type), a batch
 * write, or a `ctx.db.<table>.*` facade write. The `cross_module_table_write`
 * input alongside {@link AdvisorInsertWrite}.
 */
export interface AdvisorTableWrite extends AdvisorInsertWrite {
    /** The writer method called, e.g. `patch`, `deleteMany`, `upsert`. */
    method: string;
}
