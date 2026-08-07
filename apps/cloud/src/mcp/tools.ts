/**
 * MCP surface generated from the route registry (Openship's "MCP tools derived
 * from the HTTP route registry" idea — Apache-2.0 — adapted). An agent sees a
 * tool only when its route *opts in* (`RouteSpec.mcp`), the tool call dispatches
 * through the *real* router (so it passes the same auth + rate-limit + handler +
 * function-authz stack as any HTTP caller), and a hard deny-list guarantees
 * token/secret/tenant-access/webhook routes can never become tools even if one
 * is mistakenly annotated.
 *
 * Pure over the route list + an injected router `fetch`, so the whole surface is
 * unit-testable without a live MCP transport.
 */
import type { RegisteredRoute, RouteAuth } from "../deploy/route-registry";

/** Bearer-callable auth kinds — the only ones an agent (holding a deploy key or admin token) can drive. */
const TOOLABLE_AUTH: ReadonlySet<RouteAuth> = new Set<RouteAuth>(["adminToken", "deployKey"]);

/**
 * Paths that must NEVER be exposed as tools regardless of annotation — the
 * belt to the opt-in's suspenders. `/v1/secrets` writes tenant secrets,
 * `/v1/cloudflare-billing` writes a Cloudflare Billing-Read token,
 * `/v1/admin` proxies into a tenant, `/v1/invitations/send` mints invite tokens,
 * `/v1/logs/tail` holds the tail secret, and `/v1/mcp` is the surface itself
 * (a tool that re-enters the surface would be a scope-escape vector — the same
 * reason Openship hard-denies `tokens`/`auth`/`mcp`).
 */
export const MCP_DENY_PATHS: ReadonlySet<string> = new Set([
    "/v1/admin",
    "/v1/cloudflare-billing",
    "/v1/invitations/send",
    "/v1/logs/tail",
    "/v1/mcp",
    "/v1/secrets",
]);

/** An MCP tool descriptor derived from a route. */
export interface McpTool {
    description: string;
    method: "GET" | "POST";
    /** Tool id — the path with `/v1/` stripped and slashes dotted (`deployments.rollback`). */
    name: string;
    path: string;
}

const toolName = (path: string): string => path.replace(/^\/v1\//, "").replaceAll("/", ".");

/** A tool paired with the route it dispatches to — the MCP handler's dispatch table. */
export interface McpToolRoute<Handler> {
    route: RegisteredRoute<Handler>;
    tool: McpTool;
}

/**
 * The tools an agent may call, paired with their routes: routes that opt in via
 * `spec.mcp`, are bearer-callable, and are not hard-denied. Deny + auth checks
 * win over the opt-in, so a mistaken `mcp` block on a sensitive route is inert.
 */
export const mcpToolRoutes = <Handler>(routes: ReadonlyArray<RegisteredRoute<Handler>>): McpToolRoute<Handler>[] =>
    routes
        .filter((route) => route.spec.mcp !== undefined && TOOLABLE_AUTH.has(route.spec.auth) && !MCP_DENY_PATHS.has(route.path))
        .map((route) => {
            return {
                route,
                tool: { description: route.spec.mcp?.description ?? "", method: route.method, name: toolName(route.path), path: route.path },
            };
        });
