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
import { createLunoraMcpServer, resolveClient } from "./server";

/** {@link createMcpFetchHandler} options: the server's, plus this transport's body limit. */
export interface McpFetchHandlerOptions extends LunoraMcpServerOptions {
    /**
     * Largest accepted request body, in bytes — enforced while the body streams
     * in, not after it is buffered. Defaults to `DEFAULT_MAX_REQUEST_BYTES`
     * (128 KiB), which a value that is not a non-negative safe integer also
     * falls back to.
     */
    maxRequestBytes?: number;
}

/**
 * Build a stateless Streamable-HTTP fetch handler for a Lunora MCP server. Each
 * invocation constructs a fresh proxy server and serves the request through
 * {@link serveStateless}.
 *
 * The `LunoraClient` is resolved ONCE, here, and shared by every request: it is
 * the same deployment on each one, and the public-function registry memo in
 * `./tools` is keyed by client identity, so a per-request client would re-fetch
 * that registry on every tool call. A misconfiguration (`url` without `token`)
 * therefore throws when the handler is built rather than on first request,
 * which is where `createLunoraMcpServer` already documents reporting it.
 */
export const createMcpFetchHandler = (options: McpFetchHandlerOptions): McpFetchHandler => {
    const client = resolveClient(options);

    return (request: Request): Promise<Response> =>
        serveStateless(createLunoraMcpServer({ ...options, client }), request, { maxRequestBytes: options.maxRequestBytes });
};

export { DEFAULT_MAX_REQUEST_BYTES, type McpFetchHandler, serveStateless, type ServeStatelessOptions } from "./serve-stateless";
