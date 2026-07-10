/**
 * Serve a Lunora MCP server over **Streamable HTTP** — the remote transport MCP
 * clients use when they connect over the network instead of spawning the
 * `lunora-mcp` stdio binary. The handler is a Web-Standard `fetch` function
 * (`Request` → `Response`), so it runs unchanged on Cloudflare Workers, Node
 * 18+, Deno, and Bun.
 *
 * It runs **stateless**: each request builds a fresh `Server` + transport (no
 * session id, buffered JSON responses), which suits a short-lived RPC proxy and
 * needs no cross-request session store. This HTTP boundary is also the seam paid
 * MCP tools gate on — an HTTP request can carry `X-PAYMENT`, which stdio cannot.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer } from "./server";

/** A Web-Standard fetch handler: takes a `Request`, returns the MCP `Response`. */
export type McpFetchHandler = (request: Request) => Promise<Response>;

/**
 * Build a stateless Streamable-HTTP fetch handler for a Lunora MCP server.
 *
 * Each invocation constructs a new `Server` + `WebStandardStreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined` → stateless; `enableJsonResponse: true` → a
 * buffered JSON response rather than a long-lived SSE stream), connects them,
 * and lets the transport turn the request into the JSON-RPC response. The pair
 * is closed once the response is built — a best-effort, fire-and-forget cleanup
 * that never masks or delays the response — so nothing leaks between requests.
 */
export const createMcpFetchHandler =
    (options: LunoraMcpServerOptions): McpFetchHandler =>
    async (request: Request): Promise<Response> => {
        const server = createLunoraMcpServer(options);
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });

        await server.connect(transport);

        // `enableJsonResponse` buffers the whole JSON-RPC response into the
        // returned `Response`, so closing the transport/server afterwards can't
        // truncate an in-flight body. Cleanup is fire-and-forget with swallowed
        // rejections (a `.catch()`-terminated chain) so it never delays or masks
        // the resolved response.
        const response = await transport.handleRequest(request);

        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);

        return response;
    };
