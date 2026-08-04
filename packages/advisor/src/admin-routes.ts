/**
 * One `httpRoute.<verb>("/admin/…")` REST route on an admin/privileged-looking
 * path, with whether its handler references an auth/admin guard — the input the
 * `admin_route_without_guard` lint consumes. Produced by the codegen feeder;
 * runtime callers don't supply it, so the lint finds nothing there.
 */
export interface AdvisorAdminRoute {
    /** The exported binding name of the route handler. */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** HTTP verb the route binds to (uppercased), e.g. `"POST"`. */
    method: string;
    /** The route path, e.g. `/admin/users`. */
    path: string;
    /** `true` when the handler references an auth/session/admin guard. */
    usesGuard: boolean;
}
