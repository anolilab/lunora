/**
 * One query read discovered in a function body — the input the
 * `filter_without_index` lint consumes. Produced by the codegen feeder (which
 * parses `ctx.db.query("table")…` chains from the AST); runtime callers don't
 * supply it, so the lint simply finds nothing there.
 */
export interface AdvisorQueryRead {
    /** Source file the read appears in (relative to the cirrus dir, no extension). */
    file: string;
    /** True when the chain calls `.filter(...)`. */
    hasFilter: boolean;
    /** True when the chain narrows with `.withIndex(...)` or `.withSearchIndex(...)`. */
    hasIndex: boolean;
    /** 1-based line of the `query(...)` call, or `0` when unknown. */
    line: number;
    /** The queried table; empty when the `query(...)` argument is not a string literal. */
    table: string;
}
