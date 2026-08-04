/**
 * One `ctx.vectors.<method>(indexName, input)` call whose `input.namespace` is
 * derived from the handler's `args` with no server-side scoping — the input the
 * `vectors_namespace_from_user_input` lint consumes. A Vectorize namespace
 * partitions one index into isolated sub-collections, so a namespace taken
 * straight from request input lets any caller read or poison another tenant's
 * vectors. A fixed literal namespace, or one prefixed with a server-trusted
 * identity (`` `${ctx.auth.orgId}` `` — references `ctx`, so treated as
 * scoped), is not recorded; only an arg-derived, unscoped namespace reaches
 * here. Produced by the codegen feeder; runtime callers don't supply it, so
 * the lint finds nothing there.
 */
export interface AdvisorVectorNamespaceAccess {
    /** The exported binding name of the procedure performing the `ctx.vectors` access. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.vectors` call, or `0` when unknown. */
    line: number;
    /** The `ctx.vectors` method invoked: `query` / `upsert` / `upsertMany`. */
    method: string;
}
