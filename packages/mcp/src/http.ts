/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`); here it appears only as a parameter type. */

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
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer } from "./server";

/** A Web-Standard fetch handler: takes a `Request`, returns the MCP `Response`. */
export type McpFetchHandler = (request: Request) => Promise<Response>;

/**
 * Drive one request through a fresh **stateless** Streamable-HTTP transport bound
 * to `server`, then tear both down.
 *
 * `sessionIdGenerator: undefined` → stateless (no cross-request session store);
 * `enableJsonResponse: true` → the whole JSON-RPC response is buffered into the
 * returned `Response`, so closing the transport/server afterwards can't truncate
 * an in-flight body. Cleanup is fire-and-forget with swallowed rejections (a
 * `.catch()`-terminated chain) so it never delays or masks the resolved response.
 *
 * `options.parsedBody` lets a caller hand over a body it already read (e.g. the
 * paid-tool gate, which peeks the JSON-RPC message to price the call) so the
 * transport doesn't re-read a consumed stream.
 */
export const serveStateless = async (server: Server, request: Request, options?: HandleRequestOptions): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });

    await server.connect(transport);

    const response = await transport.handleRequest(request, options);

    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);

    return response;
};

/**
 * Build a stateless Streamable-HTTP fetch handler for a Lunora MCP server. Each
 * invocation constructs a fresh proxy server and serves the request through
 * {@link serveStateless}.
 */
export const createMcpFetchHandler =
    (options: LunoraMcpServerOptions): McpFetchHandler =>
    (request: Request): Promise<Response> =>
        serveStateless(createLunoraMcpServer(options), request);
