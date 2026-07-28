/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`); here it appears only as a parameter type. */

/**
 * Drive one MCP request through a **stateless** Streamable-HTTP transport.
 *
 * Split out of `./http` so a Workers/browser-targeted surface (notably
 * `./docs`) can reach it without importing `./server`, which reads
 * `package.json` off disk at module load and would drag `node:fs` into the
 * bundle. `./http` re-exports it, so its public API is unchanged.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** A Web-Standard fetch handler: takes a `Request`, returns the MCP `Response`. */
type McpFetchHandler = (request: Request) => Promise<Response>;

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
 *
 * Teardown runs in a `finally`: a rejection from `connect` or `handleRequest`
 * would otherwise skip it and leak a server + transport per failed request,
 * which on a public endpoint is exactly the request an attacker can repeat.
 */
const serveStateless = async (server: Server, request: Request, options?: HandleRequestOptions): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });

    try {
        await server.connect(transport);

        return await transport.handleRequest(request, options);
    } finally {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
    }
};

export type { McpFetchHandler };
export { serveStateless };
