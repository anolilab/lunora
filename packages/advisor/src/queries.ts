/**
 * One query read discovered in a function body — the input the
 * `filter_without_index` lint consumes. Produced by the codegen feeder (which
 * parses `ctx.db.query("table")…` chains from the AST); runtime callers don't
 * supply it, so the lint simply finds nothing there.
 */
export interface AdvisorQueryRead {
    /**
     * The exported procedure the read sits in, when the feeder could resolve one.
     * Carried so the advisor map can attribute the finding to that procedure's row
     * rather than to the project bucket; a read outside any export (module scope)
     * legitimately has none.
     *
     * Optional so a feeder predating this field still typechecks — such a run
     * simply attributes project-wide, exactly as before.
     */
    exportName?: string;
    /** Source file the read appears in (relative to the lunora dir, no extension). */
    file: string;

    /**
     * True when the chain's `.filter()` predicate compares `_id`
     * (`(d) => d._id === args.id`) — a full scan for a row that `ctx.db.get`
     * addresses directly. Optional so a feeder predating this field still
     * typechecks; absent is treated as "not a primary-key filter".
     */
    filtersPrimaryKey?: boolean;
    /** True when the chain calls `.filter(...)`. */
    hasFilter: boolean;
    /** True when the chain narrows with `.withIndex(...)` or `.withSearchIndex(...)`. */
    hasIndex: boolean;
    /** 1-based line of the `query(...)` call, or `0` when unknown. */
    line: number;
    /** The queried table; empty when the `query(...)` argument is not a string literal. */
    table: string;
}
