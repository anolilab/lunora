import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an `httpRoute` on an admin/privileged-looking path whose handler shows no
 * auth/admin guard.
 *
 * REST routes (unlike queries/mutations) aren't covered by RLS — they run whatever
 * the handler does, so an `/admin/*` (or `/internal/*`, `/_*`) route with no
 * session/admin check is an open privilege door: anyone who can reach the URL can
 * invoke it. The handler must assert an authenticated, authorized caller
 * (`ctx.auth` / `getSession` / a `requireAdmin`-style guard) before doing
 * privileged work.
 *
 * Detection is heuristic: the feeder records whether the handler body references
 * any known guard token. Runs only when the codegen feeder supplies route evidence
 * (`context.adminRoutes`); a runtime caller flags nothing.
 */
const adminRouteWithoutGuard: Lint = {
    categories: ["SECURITY"],
    description:
        "An `httpRoute` on an admin/privileged path has no visible auth/admin guard. REST routes aren't covered by RLS, so an unguarded `/admin/*` route is callable by anyone who reaches the URL.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "admin_route_without_guard",
    remediation:
        "Assert an authenticated, authorized caller at the top of the handler — check `ctx.auth` / `getSession(...)`, or a `requireAdmin`-style guard — and reject (401/403) before doing privileged work. For machine callers, verify a secret with a timing-safe compare.",
    run: (context) => {
        if (context.adminRoutes === undefined) {
            return [];
        }

        return context.adminRoutes
            .filter((route) => !route.usesGuard)
            .map((route) =>
                emit(adminRouteWithoutGuard, {
                    cacheKey: `admin_route_without_guard:${route.file}:${route.method}:${route.path}`,
                    detail: `Route \`${route.method} ${route.path}\` (\`${route.exportName}\` in ${route.file}) is on an admin/privileged path but its handler shows no auth/admin guard. Assert an authorized caller before doing privileged work.`,
                    metadata: { exportName: route.exportName, file: route.file, method: route.method, path: route.path },
                }),
            );
    },
    source: "static",
    title: "Admin route without an auth guard",
};

export default adminRouteWithoutGuard;
