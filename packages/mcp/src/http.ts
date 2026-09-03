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
 *
 * The transport plumbing itself lives in `./serve-stateless`, which this module
 * re-exports unchanged; keeping it there lets the Workers-safe `./docs` surface
 * reuse it without pulling in this module's `./server` import, which reads
 * `package.json` off disk at load time.
 */
import type { McpFetchHandler } from "./serve-stateless";
import { serveStateless } from "./serve-stateless";
import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer } from "./server";

/**
 * Build a stateless Streamable-HTTP fetch handler for a Lunora MCP server. Each
 * invocation constructs a fresh proxy server and serves the request through
 * {@link serveStateless}.
 */
export const createMcpFetchHandler =
    (options: LunoraMcpServerOptions): McpFetchHandler =>
    (request: Request): Promise<Response> =>
        serveStateless(createLunoraMcpServer(options), request);

export { type McpFetchHandler, serveStateless, type ServeStatelessOptions } from "./serve-stateless";
