import { createDocsMcpFetchHandler } from "@lunora/mcp/docs";
import { RateLimiter } from "@lunora/ratelimit";
import { createFileRoute } from "@tanstack/react-router";

import { mcpDocsIndex } from "@/lib/mcp-docs-index";

/**
 * `/mcp` — the Lunora documentation as a Model Context Protocol server, over
 * Streamable HTTP.
 *
 * Point any MCP client at `https://lunora.sh/mcp` and its agent can search and
 * read these docs while it writes Lunora code, instead of guessing at the API.
 * The surface is read-only published documentation, so the endpoint is
 * deliberately **unauthenticated** — there is nothing to scope and no token for
 * a user to mismanage.
 */
const handle = createDocsMcpFetchHandler({ index: mcpDocsIndex });

/**
 * Per-caller request budget.
 *
 * The handler already bounds what a single request can cost — bodies are
 * capped, batches refused — but nothing bounded how MANY. This is the other
 * half: an anonymous caller gets a generous allowance for real agent use
 * (search, read a page, read another) and no more.
 *
 * Uses `@lunora/ratelimit`'s default in-memory store, which is per-isolate. On a
 * platform that fans requests across isolates that makes this a speed bump
 * rather than a wall — the real ceiling belongs at the CDN — but a speed bump
 * that costs one Map is worth having, and it is exact for the single-instance
 * case.
 */
const limiter = new RateLimiter({
    // A sliding window, so a caller can't spend the whole allowance twice by
    // straddling a fixed boundary. 120/min is far above real agent use — search,
    // read, read again — and far below what makes the endpoint a resource.
    config: { mcp: { kind: "sliding window", period: 60_000, rate: 120 } },
});

/**
 * The caller's address, from whichever proxy header the host sets. Falls back to
 * one shared bucket rather than to "unlimited": if we cannot tell callers apart,
 * the safe reading is that they might be one caller.
 */
const callerKey = (request: Request): string => {
    const forwarded = request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("x-forwarded-for") ?? "";

    return forwarded.split(",")[0]?.trim() || "unknown";
};

/**
 * Browser-visible help for someone who opens the URL by hand. An MCP client
 * opening the SSE stream sends `accept: text/event-stream`, so this only
 * intercepts the plain-navigation case.
 */
const CONNECT_HELP = `Lunora documentation — Model Context Protocol server

This endpoint speaks MCP over Streamable HTTP; it is not meant to be browsed.

Connect a client:

  claude mcp add --transport http lunora-docs https://lunora.sh/mcp

Or add it to your editor's MCP config:

  { "mcpServers": { "lunora-docs": { "url": "https://lunora.sh/mcp" } } }

Tools: lunora_search_docs, lunora_get_doc, lunora_list_docs.
`;

/**
 * A public, credential-free endpoint that any agent may call, so allow
 * cross-origin use — including from browser-based clients, which need the MCP
 * session/protocol headers on both the request and the exposed response.
 */
const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
    "access-control-max-age": "86400",
};

const withCors = (response: Response): Response => {
    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
    }

    // Every response is a JSON-RPC reply to this exact request. Caching one and
    // replaying it for another caller would be wrong, and no CDN should try.
    headers.set("cache-control", "no-store");

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

/** Serve one MCP request, refusing it when the caller is over budget. */
const serve = async (request: Request): Promise<Response> => {
    const status = await limiter.limit("mcp", { key: callerKey(request) });

    if (!status.ok) {
        return withCors(
            Response.json(
                // eslint-disable-next-line unicorn/no-null -- JSON-RPC 2.0 specifies `null`, not an absent field, for an uncorrelated error
                { error: { code: -32_000, message: "rate limit exceeded — slow down" }, id: null, jsonrpc: "2.0" },
                {
                    headers: { "retry-after": String(Math.max(1, Math.ceil(status.retryAfter / 1000))) },
                    status: 429,
                },
            ),
        );
    }

    return withCors(await handle(request));
};

export const Route = createFileRoute("/mcp")({
    server: {
        handlers: {
            DELETE: async ({ request }) => serve(request),
            GET: async ({ request }) => {
                // Media types are case-insensitive, so a compliant `Text/Event-Stream`
                // must reach the transport rather than the help page.
                if (!(request.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream")) {
                    return withCors(new Response(CONNECT_HELP, { headers: { "content-type": "text/plain; charset=utf-8" } }));
                }

                return serve(request);
            },
            // eslint-disable-next-line unicorn/no-null -- the Response body must be null for a 204; `undefined` is not accepted by the Fetch API here.
            OPTIONS: () => new Response(null, { headers: CORS_HEADERS, status: 204 }),
            POST: async ({ request }) => serve(request),
        },
    },
});
