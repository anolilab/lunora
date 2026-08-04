/**
 * One `ctx.containers.<exportName>.get(name, …)` call whose instance key is
 * derived from the handler's `args` with no server-side scoping — the input
 * the `container_instance_key_from_user_input` lint consumes. A container
 * definition's `.get(name)` accessor routes to one instance per `name`, so a
 * key taken straight from request input lets any caller reach any other
 * tenant's container (a cross-tenant IDOR). A fixed literal key, or one
 * derived from a server-trusted identity (`` `${ctx.auth.userId}` `` —
 * references `ctx`, so treated as scoped), is not recorded; only an
 * arg-derived, unscoped key reaches here. Produced by the codegen feeder;
 * runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorContainerKeyAccess {
    /** The exported binding name of the procedure performing the `ctx.containers` access. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the `ctx.containers.*.get` call, or `0` when unknown. */
    line: number;
    /** The container accessor method invoked — always `get` (the only per-instance-key sink). */
    method: string;
}
