import type { ActionCtx } from "./types.js";

/** HTTP verbs an {@link HttpRouter} route can bind to. */
export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * Context handed to an HTTP action handler. A narrower view of {@link ActionCtx}:
 * HTTP actions run in the worker (the "action runtime"), separate from the
 * transactional store, so there is no direct `db` / `vectors` / `scheduler` /
 * `storage` surface — reach the data layer through `runQuery` / `runMutation` /
 * `runAction`, which forward to the owning shard.
 */
export type HttpActionCtx = Pick<ActionCtx, "auth" | "fetch" | "runAction" | "runMutation" | "runQuery">;

/** A handler bound to a route via {@link httpRouter}. Receives the raw request, returns the raw response. */
export type HttpActionHandler = (ctx: HttpActionCtx, request: Request) => Promise<Response> | Response;

/**
 * The value {@link httpAction} produces. Marked with `isHttpAction` so the
 * router (and tooling) can tell it apart from a plain function.
 */
export interface RegisteredHttpAction {
    readonly handler: HttpActionHandler;
    readonly isHttpAction: true;
}

/** Wrap a `(ctx, request) => Response` handler so it can be mounted on an {@link httpRouter}. */
export const httpAction = (handler: HttpActionHandler): RegisteredHttpAction => ({ handler, isHttpAction: true });

/** Bind a handler to an exact pathname. */
export interface ExactRouteSpec {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    path: string;
}

/** Bind a handler to every pathname under `pathPrefix` (which must end in `/`). */
export interface PrefixRouteSpec {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    pathPrefix: string;
}

export type RouteSpec = ExactRouteSpec | PrefixRouteSpec;

/** A normalised route entry, as returned by {@link HttpRouter.getRoutes}. */
export interface RouteEntry {
    handler: RegisteredHttpAction;
    method: HttpMethod;
    /** The exact pathname, or — for prefix routes — the prefix ending in `/`. */
    path: string;
    prefix: boolean;
}

/**
 * Result of {@link HttpRouter.lookup}. Distinguishes "no path matched" (→ 404)
 * from "path matched but not this method" (→ 405 with an `Allow` list) so the
 * worker can respond with the correct status.
 */
export type RouteLookup = { action: RegisteredHttpAction; kind: "match" } | { allow: HttpMethod[]; kind: "method_not_allowed" } | { kind: "not_found" };

export interface HttpRouter {
    /** All registered routes, in declaration order. */
    getRoutes: () => readonly RouteEntry[];
    /** Marker so the worker and tooling can recognise a router instance. */
    readonly isRouter: true;
    /** Resolve a request to a handler, a 405, or a 404. Exact paths beat prefixes; longest prefix wins. */
    lookup: (pathname: string, method: string) => RouteLookup;
    /** Register a route. Throws on a malformed path or a duplicate (method, path). */
    route: (spec: RouteSpec) => void;
}

const isPrefixSpec = (spec: RouteSpec): spec is PrefixRouteSpec => "pathPrefix" in spec;

/**
 * Create a router for HTTP actions. Mirrors Convex's `httpRouter()`:
 *
 * ```ts
 * const http = httpRouter();
 * http.route({ path: "/webhook", method: "POST", handler: onWebhook });
 * http.route({ pathPrefix: "/img/", method: "GET", handler: serveImage });
 * export default http;
 * ```
 *
 * Pass the router to `createWorker({ httpRouter })` so inbound requests that
 * don't hit the RPC/WebSocket endpoints are dispatched to these handlers.
 */
export const httpRouter = (): HttpRouter => {
    const routes: RouteEntry[] = [];

    const route = (spec: RouteSpec): void => {
        const prefix = isPrefixSpec(spec);
        const path = prefix ? spec.pathPrefix : spec.path;

        if (!path.startsWith("/")) {
            throw new Error(`httpRouter: ${prefix ? "pathPrefix" : "path"} must start with "/" (got ${JSON.stringify(path)})`);
        }

        if (prefix && !path.endsWith("/")) {
            throw new Error(`httpRouter: pathPrefix must end with "/" (got ${JSON.stringify(path)})`);
        }

        const duplicate = routes.some((entry) => entry.prefix === prefix && entry.path === path && entry.method === spec.method);

        if (duplicate) {
            throw new Error(`httpRouter: duplicate route for ${spec.method} ${path}`);
        }

        routes.push({ handler: spec.handler, method: spec.method, path, prefix });
    };

    const lookup = (pathname: string, method: string): RouteLookup => {
        // Gather every entry whose path/prefix matches, ignoring the method, so
        // we can tell a true 404 (no path) from a 405 (path, wrong method).
        const pathMatches = routes.filter((entry) => entry.prefix ? pathname.startsWith(entry.path) : entry.path === pathname);

        if (pathMatches.length === 0) {
            return { kind: "not_found" };
        }

        // Exact routes win over prefixes; among prefixes the longest one wins.
        const ranked = [...pathMatches].sort((a, b) => {
            if (a.prefix !== b.prefix) {
                return a.prefix ? 1 : -1;
            }

            return b.path.length - a.path.length;
        });

        const hit = ranked.find((entry) => entry.method === method);

        if (hit) {
            return { action: hit.handler, kind: "match" };
        }

        const allow = [...new Set(ranked.map((entry) => entry.method))];

        return { allow, kind: "method_not_allowed" };
    };

    return {
        getRoutes: () => routes,
        isRouter: true,
        lookup,
        route,
    };
};
