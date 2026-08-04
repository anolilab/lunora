/**
 * One `ctx.db.<table>.findMany({ with: { <rel> } })` relation-hydrating list read
 * — the shared input for the `masked_relation_leak_via_with` lint. Column
 * masking is applied per-procedure to the top-level rows of the table named in
 * the read; it does **not** descend into `with`-hydrated relations, so a masked
 * table surfaced only through a `with` on an unprotected parent read is returned
 * in the clear. The lint resolves each relation accessor to its target table and
 * joins it against the discovered mask evidence before flagging. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there. Structurally identical to `@lunora/codegen`'s `RelationLoadIR`.
 */
export interface AdvisorRelationLoad {
    /** The exported binding name of the procedure performing the read. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the read call. */
    line: number;
    /** Parent table the read targets, or `""` when it couldn't be statically resolved. */
    parentTable: string;
    /** Relation accessor names named in the read's `with: { … }` map — matched against the parent table's declared relations. */
    relations: ReadonlyArray<string>;
    /** `"internal"` for `internalQuery` / `internalMutation` / `internalAction`. */
    visibility: "internal" | "public";
}
