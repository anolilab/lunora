/**
 * One `ctx.db.<table>.findMany({ includeDeleted })` list read whose
 * `includeDeleted` is either a hardcoded `true` or derived from the handler's
 * `args` — the shared input for the `soft_delete_include_deleted_from_args`
 * lint. `includeDeleted` resurfaces rows a `.softDelete()` table would otherwise
 * hide from list reads; on a public read that means any caller (arg-derived) or
 * every caller (hardcoded `true`) can see soft-deleted rows. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there. Structurally identical to `@lunora/codegen`'s `SoftDeleteReadIR`.
 */
export interface AdvisorSoftDeleteRead {
    /** The exported binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** `true` when `includeDeleted` was derived from the handler's `args` (any caller can flip it). */
    fromArgs: boolean;
    /** `true` when `includeDeleted` was a hardcoded `true` literal (always resurfaces soft-deleted rows). */
    hardcodedTrue: boolean;
    /** 1-based line of the read call. */
    line: number;
    /** Table read, or `""` when the table couldn't be statically resolved. */
    table: string;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}
