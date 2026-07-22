/**
 * The `/v1/mcp` JSON-RPC endpoint (Openship's "MCP tools from the route
 * registry" idea). Lives beside `mcp/tools.ts` rather than inline in the router
 * factory, and dispatches a tool call to its own route handler directly — no
 * re-entry into the router (which would double-charge the rate limiter and
 * forced the router's mutable late-binding holder). The handler is built from
 * the *tool-eligible* routes only, so the `/v1/mcp` route itself is never in the
 * dispatch table (no cycle).
 *
 * Every request is gated on a valid deploy key before anything is exposed
 * (tools/list included), and each tool call re-dispatches with the caller's own
 * credential + the forwarded client IP, so authorization + per-IP limiting are
 * exactly what a direct HTTP caller gets — the MCP layer grants no privilege.
 */
import type { RegisteredRoute } from "../deploy/route-registry";
import type { McpTool } from "./tools";
import { mcpToolRoutes } from "./tools";

type RouteHandler<Environment> = (request: Request, environment: Environment) => Promise<Response>;

export interface McpHandlerDeps<Environment> {
    /** JSON error helper (reuse the router's so shapes match). */
    jsonError: (status: number, message: string) => Response;
    /** The tool-eligible (non-MCP) routes; `mcpToolRoutes` filters by opt-in + deny-list. */
    routes: readonly RegisteredRoute<RouteHandler<Environment>>[];
    /** Validate a bearer deploy key (control-plane lookup); false → reject. */
    verifyKey: (key: string, environment: Environment) => Promise<boolean>;
}

interface JsonRpcRequest {
    id?: null | number | string;
    method?: string;
    params?: { arguments?: Record<string, unknown>; name?: string };
}

const bearer = (request: Request): string => {
    const authorization = request.headers.get("authorization") ?? "";

    return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
};

/** Build the `/v1/mcp` route handler over the tool-eligible routes. */
export const createMcpRouteHandler = <Environment>(deps: McpHandlerDeps<Environment>): RouteHandler<Environment> => {
    const toolRoutes = mcpToolRoutes(deps.routes);
    const tools: McpTool[] = toolRoutes.map((entry) => entry.tool);
    const byName = new Map(toolRoutes.map((entry) => [entry.tool.name, entry]));

    return async (request, environment) => {
        const credential = bearer(request);

        if (!credential) {
            return deps.jsonError(401, "missing bearer credential");
        }

        // Validate the deploy key before exposing anything (tools/list included).
        if (!(await deps.verifyKey(credential, environment))) {
            return deps.jsonError(403, "invalid or revoked deploy key");
        }

        let rpc: JsonRpcRequest;

        try {
            rpc = await request.json();
        } catch {
            return deps.jsonError(400, "invalid JSON body");
        }

        const id = rpc.id ?? null;

        if (rpc.method === "tools/list") {
            return Response.json({
                id,
                jsonrpc: "2.0",
                result: { tools: tools.map((tool) => ({ description: tool.description, inputSchema: { type: "object" }, name: tool.name })) },
            });
        }

        if (rpc.method === "tools/call") {
            const name = rpc.params?.name;
            const entry = name === undefined ? undefined : byName.get(name);

            if (!entry) {
                return Response.json({
                    id,
                    jsonrpc: "2.0",
                    result: { content: [{ text: JSON.stringify({ error: `unknown tool: ${name ?? ""}` }), type: "text" }], isError: true },
                });
            }

            // Dispatch to the tool's own route with the caller's credential (same
            // auth path) and the forwarded client IP (so per-IP limiting holds).
            const clientIp = request.headers.get("cf-connecting-ip");
            const inner = new Request(`https://cloud${entry.route.path}`, {
                ...(entry.route.method === "POST" ? { body: JSON.stringify(rpc.params?.arguments ?? {}) } : {}),
                headers: {
                    authorization: `Bearer ${credential}`,
                    "content-type": "application/json",
                    ...(clientIp ? { "cf-connecting-ip": clientIp } : {}),
                },
                method: entry.route.method,
            });

            const response = await entry.route.handler(inner, environment);
            const body: unknown = await response.json().catch(() => null);

            return Response.json({ id, jsonrpc: "2.0", result: { content: [{ text: JSON.stringify(body), type: "text" }], isError: response.status >= 400 } });
        }

        return Response.json({ error: { code: -32601, message: `unknown method: ${String(rpc.method)}` }, id, jsonrpc: "2.0" });
    };
};
