/**
 * One `ctx.storage.&lt;bucket>.&lt;method>(key, …)` call whose R2 object key is derived
 * from the handler's `args` with no server-side scoping — the input the
 * `storage_key_from_user_args` lint consumes. An object key taken straight from
 * request input lets any caller read, overwrite, or delete another user's object
 * (object-level IDOR). A key prefixed with a server-trusted identity (a `ctx.*`
 * value such as `` `${ctx.auth.userId}/…` ``) is treated as scoped and is *not*
 * recorded; only an arg-derived, `ctx`-free key reaches here. Produced by the
 * codegen feeder; runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorStorageKeyAccess {
    /** The exported binding name of the procedure performing the storage call. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the storage call, or `0` when unknown. */
    line: number;
    /** The bucket method invoked with the arg-derived key, e.g. `get` / `put` / `delete` / `download`. */
    method: string;
    /**
     * Visibility of the enclosing procedure. `internal` procedures are not
     * reachable by a caller, so the "any caller can read/overwrite/delete
     * another user's object" premise does not hold there and the finding drops
     * to `INFO` (mirrors `AdvisorOwnerFieldWrite.visibility`). `undefined` when
     * the feeder could not attribute the access to a registered procedure.
     */
    visibility?: "internal" | "public";
}
