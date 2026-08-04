/**
 * One discovered `httpAction`/`httpRoute` handler that performs a side effect
 * (`ctx.runMutation` / `ctx.runAction` / a `ctx.db.{insert,patch,replace,delete,
 * insertManyUnsafe}` write) from the HTTP edge, with whether it reads `ctx.auth`
 * — the `http_action_missing_auth_guard` lint input. A handler that mutates state
 * or dispatches an action without ever consulting the request identity is an
 * unauthenticated write bypassing identity/RLS (distinct from
 * `admin_route_without_guard`, which covers Studio/admin paths). Only handlers
 * with a statically-resolvable inline body and `ctx` binding are recorded
 * (fail-safe under-report); read-only handlers are never recorded. Produced by
 * the codegen feeder; runtime callers don't supply it, so the lint finds nothing
 * there.
 */
export interface AdvisorHttpActionGuard {
    /** The exported binding name of the handler (or `"<module>"` when mounted inline / not a named binding). */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** Which HTTP surface the handler is: a raw `httpAction` or a typed `httpRoute` route. */
    kind: "httpAction" | "httpRoute";
    /** 1-based line of the handler call, or `0` when unknown. */
    line: number;
    /** For an `httpRoute`, the uppercased verb (`"POST"`); absent for a raw `httpAction`. */
    method?: string;
    /** `true` when the handler reads `ctx.auth` (a direct member access or a `const { auth } = ctx` destructure). */
    readsAuth: boolean;
    /** The first side effect found, as a stable label: `runMutation`, `runAction`, or `db.<method>`. */
    sideEffect: string;
}
