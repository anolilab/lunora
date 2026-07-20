/**
 * Control-plane route classification + boot scanner (Openship's route-scanner
 * idea — github.com/oblien/openship, Apache-2.0 — adapted to our `/v1` router).
 *
 * Every control-plane HTTP route must declare *how it is authenticated*. The
 * scanner runs once when `createDeployRouter` builds the table, so a route added
 * without an explicit classification — or a `public` route that never justifies
 * itself — makes the Worker fail to construct rather than shipping an
 * unclassified endpoint a later reader assumes is protected.
 *
 * This does not replace the per-handler auth (each handler still verifies its
 * bearer key / HMAC / admin token, and the delegated Lunora functions still
 * `assertMember` / `authorizeDeployKey`). It is the *cannot-forget-to-classify*
 * gate: the enforcement lives in the handler, the classification lives here, and
 * the two can be cross-checked. It also powers the MCP surface, which only ever
 * exposes routes whose spec opts in.
 */

/** How a control-plane route authenticates the caller. */
export type RouteAuth =
    // Bearer `LUNORA_ADMIN_TOKEN` — the platform/dispatcher trust boundary.
    | "adminToken"
    // Bearer org deploy key — CI/deploy callers with no user session.
    | "deployKey"
    // Deliberately unauthenticated — MUST set `reason`.
    | "public"
    // better-auth member session (the delegated function `assertMember`s).
    | "session"
    // Shared `LUNORA_TAIL_SECRET` presented by the dispatch-namespace tail worker.
    | "tailSecret"
    // Provider HMAC signature (GitHub `x-hub-signature-256`, Creem `creem-signature`).
    | "webhookHmac";

export interface RouteSpec {
    auth: RouteAuth;
    /**
     * Expose this route as an MCP tool (opt-in). Never set on token-minting /
     * auth / webhook routes — see the MCP surface's deny-list.
     */
    mcp?: { description: string };
    /** Required when `auth === "public"`: why the route is safe unauthenticated. */
    reason?: string;
}

export interface RegisteredRoute<Handler> {
    handler: Handler;
    method: "GET" | "POST";
    /** Exact pathname (`/v1/deploy`) — matched by the flat dispatcher. */
    path: string;
    spec: RouteSpec;
}

const VALID_AUTH: ReadonlySet<RouteAuth> = new Set<RouteAuth>(["adminToken", "deployKey", "public", "session", "tailSecret", "webhookHmac"]);

/**
 * Fail construction unless every route is classified. Throws on: a missing or
 * unknown `auth`, a `public` route with no `reason`, or a duplicate
 * `(method, path)` (a table typo that would silently shadow a route). Returns
 * the routes so callers can build their dispatch tables off the checked list.
 */
export const assertRoutesClassified = <Handler>(routes: readonly RegisteredRoute<Handler>[]): readonly RegisteredRoute<Handler>[] => {
    const seen = new Set<string>();

    for (const route of routes) {
        const where = `${route.method} ${route.path}`;

        if (!route.spec || !VALID_AUTH.has(route.spec.auth)) {
            throw new Error(`route ${where} has no valid auth classification (RouteSpec.auth)`);
        }

        if (route.spec.auth === "public" && !route.spec.reason?.trim()) {
            throw new Error(`public route ${where} must document why it is unauthenticated (RouteSpec.reason)`);
        }

        if (seen.has(where)) {
            throw new Error(`duplicate route ${where}`);
        }

        seen.add(where);
    }

    return routes;
};
