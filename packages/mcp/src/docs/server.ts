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
import { docsTools } from "./tools";
import type { DocsIndex } from "./types";

/** Server identity advertised in the MCP `initialize` handshake. */
const DOCS_SERVER_NAME = "lunora-docs";

/**
 * Largest request body served. Every documentation call is a short JSON-RPC
 * message — a few hundred bytes — so this is orders of magnitude of headroom
 * while still bounding what an anonymous caller can push through the parser.
 */
const DEFAULT_MAX_REQUEST_BYTES: number = 128 * 1024;

interface DocsMcpServerOptions {
    /** The documentation source the tools read. */
    index: DocsIndex;

    /** Largest accepted request body. Defaults to {@link DEFAULT_MAX_REQUEST_BYTES}. */
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
const createDocsMcpServer = (options: DocsMcpServerOptions): Server => createToolServer(serverInfo(options.version), docsTools(options.index));

/** UTF-8 byte length of `value` — what a byte limit must actually measure. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Either a rejection to return as-is, or the parsed body to hand to the transport. */
type ScreenedRequest = { parsedBody: unknown } | { response: Response };

/**
 * A JSON-RPC error response, as its own HTTP response.
 *
 * `id: null` is the protocol's own requirement for an error that cannot be
 * correlated to a request id — which is exactly the case when the body was
 * rejected before it was understood.
 */
const rpcError = (status: number, code: number, message: string): Response =>
    // eslint-disable-next-line unicorn/no-null -- JSON-RPC 2.0 specifies `null`, not an absent field, for an uncorrelated error
    Response.json({ error: { code, message }, id: null, jsonrpc: "2.0" }, { status });

/**
 * Reject what a documentation server has no reason to accept, before the
 * transport sees it.
 *
 * This surface is meant to be hosted **unauthenticated**, which makes it the one
 * place in the package where an anonymous caller controls the work done. Two
 * limits close the gap between "cheap request" and "expensive response":
 *
 * - **Body size.** Bounded so a large body can't be pushed through the parser.
 * - **No JSON-RPC batches.** The spec allows an array of messages, and the
 * stateless transport buffers the whole batch's replies into one body before
 * responding — so a single small request carrying thousands of `tools/call`
 * messages amplifies into hundreds of megabytes out, with no `initialize` and no
 * session to rate-limit against. Batching buys a docs client nothing, so the
 * honest answer is to refuse it rather than to tune it.
 *
 * Returns the rejection `Response`, or the already-parsed body to hand to the
 * transport so it isn't read twice.
 */
const screenRequest = async (request: Request, maxRequestBytes: number): Promise<ScreenedRequest> => {
    if (request.method !== "POST") {
        return { parsedBody: undefined };
    }

    const tooLarge = { response: rpcError(413, -32_600, `request body exceeds ${String(maxRequestBytes)} bytes`) };
    const declaredLength = Number(request.headers.get("content-length"));

    // Reject on the declared length FIRST, so an oversized body is refused
    // before it is buffered into the isolate. A chunked request without the
    // header still has to be read, which is why the authoritative check below
    // stays — but the common case costs nothing.
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
        return tooLarge;
    }

    const body = await request.text();

    // `String.length` counts UTF-16 code units, so a limit expressed in bytes
    // has to be measured in bytes: 128 KiB of three-byte UTF-8 is ~43k units,
    // which a naive length check would wave through.
    if (byteLength(body) > maxRequestBytes) {
        return tooLarge;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(body);
    } catch {
        return { response: rpcError(400, -32_700, "parse error: body is not valid JSON") };
    }

    if (Array.isArray(parsed)) {
        return { response: rpcError(400, -32_600, "batched requests are not supported: send one JSON-RPC message per request") };
    }

    return { parsedBody: parsed };
};

/**
 * Build a stateless Streamable-HTTP fetch handler serving the documentation
 * tools — the `Request` → `Response` function a docs site mounts at `/mcp`.
 *
 * A fresh server per request keeps the handler safe on platforms that fan
 * requests across isolates, where nothing may be assumed to persist between
 * them.
 */
const createDocsMcpFetchHandler = (options: DocsMcpServerOptions): McpFetchHandler => {
    const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

    return async (request: Request): Promise<Response> => {
        const screened = await screenRequest(request, maxRequestBytes);

        if ("response" in screened) {
            return screened.response;
        }

        return serveStateless(createDocsMcpServer(options), request, screened.parsedBody === undefined ? undefined : { parsedBody: screened.parsedBody });
    };
};

export type { DocsMcpServerOptions };
export { createDocsMcpFetchHandler, createDocsMcpServer, DEFAULT_MAX_REQUEST_BYTES, DOCS_SERVER_NAME };
