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
 * `/v1/admin` proxies into a tenant, `/v1/invitations/send` mints invite tokens,
 * `/v1/logs/tail` holds the tail secret, and `/v1/mcp` is the surface itself
 * (a tool that re-enters the surface would be a scope-escape vector — the same
 * reason Openship hard-denies `tokens`/`auth`/`mcp`).
 */
export const MCP_DENY_PATHS: ReadonlySet<string> = new Set(["/v1/admin", "/v1/invitations/send", "/v1/logs/tail", "/v1/mcp", "/v1/secrets"]);

/** An MCP tool descriptor derived from a route. */
export interface McpTool {
    description: string;
    method: "GET" | "POST";
    /** Tool id — the path with `/v1/` stripped and slashes dotted (`deployments.rollback`). */
    name: string;
    path: string;
}

const toolName = (path: string): string => path.replace(/^\/v1\//, "").replaceAll("/", ".");

/**
 * The tools an agent may call: routes that opt in via `spec.mcp`, are
 * bearer-callable, and are not hard-denied. Deny + auth checks win over the
 * opt-in, so a mistaken `mcp` block on a sensitive route is inert.
 */
export const buildMcpTools = <Handler>(routes: readonly RegisteredRoute<Handler>[]): McpTool[] =>
    routes
        .filter((route) => route.spec.mcp !== undefined && TOOLABLE_AUTH.has(route.spec.auth) && !MCP_DENY_PATHS.has(route.path))
        .map((route) => ({ description: route.spec.mcp?.description ?? "", method: route.method, name: toolName(route.path), path: route.path }));

/** Minimal router surface the dispatcher drives — the control-plane `fetch`. */
export interface McpRouterLike {
    fetch: (request: Request, environment?: unknown) => Promise<Response>;
}

export interface McpToolCall {
    /** JSON arguments forwarded as the route's request body (POST) or ignored (GET). */
    arguments?: Record<string, unknown>;
    /** The caller's bearer credential (deploy key / admin token) — reused for the inner route call. */
    credential: string;
    /** Tool id from {@link buildMcpTools}. */
    name: string;
}

export interface McpToolResult {
    body: unknown;
    /** True when the underlying route returned < 400. */
    ok: boolean;
    status: number;
}

/**
 * Invoke a tool by dispatching through the real router with the caller's own
 * credential, so authorization is exactly what an HTTP caller would get — the
 * MCP layer adds no privilege. Returns a structural result; an unknown tool name
 * is a 404 (never a silent pass to an un-tooled route).
 */
export const dispatchMcpTool = async (
    router: McpRouterLike,
    tools: readonly McpTool[],
    call: McpToolCall,
    options: { environment?: unknown; origin?: string } = {},
): Promise<McpToolResult> => {
    const tool = tools.find((candidate) => candidate.name === call.name);

    if (!tool) {
        return { body: { error: `unknown tool: ${call.name}` }, ok: false, status: 404 };
    }

    const origin = options.origin ?? "https://cloud";
    const request = new Request(`${origin}${tool.path}`, {
        ...(tool.method === "POST" ? { body: JSON.stringify(call.arguments ?? {}) } : {}),
        headers: { authorization: `Bearer ${call.credential}`, "content-type": "application/json" },
        method: tool.method,
    });

    const response = await router.fetch(request, options.environment);
    const body: unknown = await response.json().catch(() => null);

    return { body, ok: response.status < 400, status: response.status };
};
