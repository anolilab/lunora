/**
 * One masked column whose `mask(policies)` strategy is a statically-known
 * literal (`"hash"` or `"redact"`) — the `mask_weak_hash_strategy_on_pii` lint
 * input. Unlike `AdvisorMaskProcedure` (one row per procedure, `maskColumns`
 * without a strategy), this is one row per masked column with its strategy
 * literal attached, so the lint can flag `"hash"` applied to a PII-named
 * column. A `MaskFn` (custom, non-literal) strategy carries no lint-relevant
 * signal and is never recorded here. Produced by the codegen feeder; runtime
 * callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorMaskStrategy {
    /** Masked column name. */
    column: string;
    /** The exported binding name of the procedure whose `.use(mask(...))` chain declared this column, or `"<module>"` when declared at file scope. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the masked column's strategy property. */
    line: number;
    /** The statically-known strategy literal: `"hash"` or `"redact"`. */
    strategy: string;
    /** Logical table the masked column belongs to. */
    table: string;
}
