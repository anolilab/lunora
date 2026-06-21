/**
 * One `ctx.sql` tagged-template interpolation that splices an unparameterized
 * string-building expression into the query — the input the `sql_injection_risk`
 * lint consumes. A `${…}` placeholder that simply names a value is bound as a
 * parameter by the Hyperdrive driver and is *not* recorded; only in-place string
 * construction (`"… " + raw`, a nested template literal) reaches here. Produced by
 * the codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorSqlInterpolation {
    /** The exported binding name of the procedure performing the `ctx.sql` call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the interpolation, or `0` when unknown. */
    line: number;
}
