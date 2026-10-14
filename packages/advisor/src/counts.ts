import type { AdvisorCallSiteScope } from "./call-site-scope";

/**
 * One `count()` call discovered in a function body — the input the `count_without_index`
 * lint consumes. Produced by the codegen feeder (which reads `ctx.db.count("table", …)` and
 * `ctx.db.<table>.count(…)` from the AST); runtime callers don't supply it, so the lint
 * finds nothing there.
 */
export interface AdvisorCountRead {
    /** Source file the call appears in (relative to the lunora dir, no extension). */
    file: string;

    /**
     * The fields the count's `where` tests, when it is a plain object literal of field names.
     * Absent for a bare count and for a `where` the feeder cannot read.
     */
    filterFields?: string[];

    /**
     * `false` only when the table is known and declares no aggregate index, so the count is a
     * `COUNT(*)` scan. A counter-backed or unknown table reads `true`.
     */
    indexed: boolean;
    /** 1-based line of the `count(...)` call. */
    line: number;
    /** Who the call runs on behalf of. */
    scope: AdvisorCallSiteScope;
    /** Counted table name, or `""` when the table argument is not a string literal. */
    table: string;
}
