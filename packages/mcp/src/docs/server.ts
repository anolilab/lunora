/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`); here it appears only as a return type. */

/**
 * A documentation-only MCP server, plus the Streamable-HTTP handler a docs site
 * mounts to publish it.
 *
 * This surface reads **published documentation only** — no deployment, no
 * credentials, no writes — which is why it can be served unauthenticated at a
 * stable public URL. That matters for adoption: a user points their editor at
 * one URL and their agent stops guessing at the framework's API, with nothing
 * to configure and no token to leak.
 *
 * Nothing here touches Node built-ins, so it runs on Workers, Netlify/Vercel
 * functions, Deno, and Bun unchanged.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import type { McpServerInfo } from "../compose";
import { createToolServer } from "../compose";
import type { McpFetchHandler } from "../serve-stateless";
import { serveStateless } from "../serve-stateless";
import { docsResources } from "./resources";
import { docsTools } from "./tools";
import type { DocsIndex } from "./types";

/** Server identity advertised in the MCP `initialize` handshake. */
const DOCS_SERVER_NAME = "lunora-docs";

interface DocsMcpServerOptions {
    /** The documentation source the tools read. */
    index: DocsIndex;

    /**
     * Largest accepted request body, in bytes — enforced while the body streams
     * in, not after it is buffered. Defaults to `DEFAULT_MAX_REQUEST_BYTES`
     * (re-exported at the foot of this module), which a value that is not a
     * non-negative safe integer also falls back to.
     */
    maxRequestBytes?: number;

    /**
     * Version reported in the handshake. Defaults to `"0.0.0"` — a docs site
     * bundles this code rather than installing it, so it, not the package, is
     * the thing whose version a client would want to see.
     */
    version?: string;
}

const serverInfo = (version: string | undefined): McpServerInfo => {
    return { name: DOCS_SERVER_NAME, version: version ?? "0.0.0" };
};

/**
 * Build a transport-agnostic MCP server exposing the documentation tools.
 * Connect it yourself, or use {@link createDocsMcpFetchHandler} for the remote
 * HTTP case.
 */
const createDocsMcpServer = (options: DocsMcpServerOptions): Server =>
    createToolServer(serverInfo(options.version), docsTools(options.index), docsResources(options.index));

/**
 * Build a stateless Streamable-HTTP fetch handler serving the documentation
 * tools — the `Request` → `Response` function a docs site mounts at `/mcp`.
 *
 * A fresh server per request keeps the handler safe on platforms that fan
 * requests across isolates, where nothing may be assumed to persist between
 * them.
 */
const createDocsMcpFetchHandler =
    (options: DocsMcpServerOptions): McpFetchHandler =>
    (request: Request): Promise<Response> =>
        serveStateless(createDocsMcpServer(options), request, { maxRequestBytes: options.maxRequestBytes });

export type { DocsMcpServerOptions };
export { createDocsMcpFetchHandler, createDocsMcpServer, DOCS_SERVER_NAME };

export { DEFAULT_MAX_REQUEST_BYTES } from "../serve-stateless";
