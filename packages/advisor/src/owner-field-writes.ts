/**
 * One `ctx.db` write (`insert` / `replace` / `patch` / `insertManyUnsafe`) that
 * sets an ownership / identity column — `userId`, `ownerId`, `tenantId`, and the
 * like — from the handler's `args` instead of the server-trusted identity. This
 * is the `owner_field_from_args_not_auth` lint input: the ownership column decides
 * who a row belongs to, so a value taken from request input lets any caller write
 * rows owned by another user or tenant (the act-as-any-user / cross-tenant IDOR
 * vector). A column stamped from `ctx.auth` / `ctx.identity`, or set to a fixed
 * literal, is *not* recorded; only an arg-derived identity write reaches here.
 * Produced by the codegen feeder; runtime callers don't supply it, so the lint
 * finds nothing there. Structurally identical to `OwnerFieldWriteIR`.
 */
export interface AdvisorOwnerFieldWrite {
    /** The exported binding name of the procedure performing the write. */
    exportName: string;
    /** The identity column being written from `args` (e.g. `userId`). */
    field: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.db` write call, or `0` when unknown. */
    line: number;
    /** The `ctx.db` write method (`insert` / `replace` / `patch` / `insertManyUnsafe`). */
    method: string;

    /**
     * Visibility of the enclosing procedure. `internal` procedures are not
     * reachable by a caller, so the "any caller can act as any user" premise
     * does not hold there and the finding drops to `INFO`. `undefined` when the
     * feeder could not attribute the write to a registered procedure.
     */
    visibility?: "internal" | "public";
}
