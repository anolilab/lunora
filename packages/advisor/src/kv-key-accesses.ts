/**
 * One `ctx.kv.<method>(key, …)` call whose namespace key is derived from the
 * handler's `args` with no server-side scoping — the input the
 * `kv_unscoped_user_key_idor` lint consumes. Workers KV is a single flat
 * namespace, so a key taken straight from request input lets any caller read,
 * overwrite, or delete another user's entry (an insecure direct object
 * reference). A fixed literal key, or one prefixed with a server-trusted identity
 * (`` `${ctx.auth.userId}:…` `` — references `ctx`, so treated as scoped), is not
 * recorded; only an arg-derived, unscoped key reaches here. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorKvKeyAccess {
    /** The exported binding name of the procedure performing the `ctx.kv` access. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.kv` call, or `0` when unknown. */
    line: number;
    /** The `ctx.kv` method invoked: `get` / `getRaw` / `getWithMetadata` / `put` / `delete`. */
    method: string;
}
