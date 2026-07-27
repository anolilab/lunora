import { createDocsMcpFetchHandler } from "@lunora/mcp/docs";
import type { RateLimitStore, RateLimitValue } from "@lunora/ratelimit";
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

/** Most distinct callers tracked at once. Past this the oldest key is dropped. */
const MAX_TRACKED_CALLERS = 10_000;

/**
 * A bounded in-memory store.
 *
 * `@lunora/ratelimit`'s default memory store is a bare `Map` with no eviction,
 * and this route keys it on a value the caller can influence. Unbounded, the
 * limiter becomes a cheaper denial of service than the endpoint it protects:
 * rotate the header and every request adds a permanent entry. Capping it and
 * evicting oldest-first bounds the damage to a fixed footprint, at the cost of
 * an attacker being able to flush honest callers' counters — the lesser of the
 * two, since that only returns them to an unlimited-but-bounded-memory state.
 */
const createBoundedStore = (): RateLimitStore => {
    const entries = new Map<string, RateLimitValue>();

    return {
        delete: (key) => {
            entries.delete(key);
        },
        get: (key) => entries.get(key),
        set: (key, value) => {
            // Re-insert so iteration order tracks recency, making the first key
            // the least recently written.
            entries.delete(key);
            entries.set(key, value);

            if (entries.size > MAX_TRACKED_CALLERS) {
                const oldest = entries.keys().next().value;

                if (oldest !== undefined) {
                    entries.delete(oldest);
                }
            }
        },
    };
};

/**
 * Per-caller request budget.
 *
 * The handler already bounds what a single request can cost — bodies are
 * capped, batches refused — but nothing bounded how MANY. A sliding window, so
 * a caller can't spend the allowance twice by straddling a fixed boundary.
 * 120/min is far above real agent use (search, read, read again) and far below
 * what makes the endpoint a resource.
 *
 * Per-isolate, so on a platform that fans requests across isolates this is a
 * speed bump and the real ceiling belongs at the CDN.
 */
const limiter = new RateLimiter({
    config: {
        mcp: { kind: "sliding window", period: 60_000, rate: 120 },
        // Callers we cannot tell apart share one bucket, so it gets a much
        // larger allowance: at the per-caller rate, one busy agent behind a
        // proxy that strips the header would lock out everyone else.
        unidentified: { kind: "sliding window", period: 60_000, rate: 1200 },
    },
    store: createBoundedStore(),
});

/** An IPv4 or IPv6 address, loosely — enough to reject a value that is not one. */
const IP_LIKE = /^[\d.:a-f]{3,45}$/iu;

/**
 * Identify the caller from whichever proxy header the host sets.
 *
 * The value is validated rather than trusted: only the platform's own header is
 * authoritative, `x-forwarded-for` is caller-controlled on any deployment that
 * isn't behind that platform, and an unvalidated value goes straight into a map
 * key. Anything that isn't address-shaped shares the `unidentified` bucket
 * instead of minting its own.
 */
const callerKey = (request: Request): { key: string; limit: "mcp" | "unidentified" } => {
    const forwarded = request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("x-forwarded-for") ?? "";
    const first = forwarded.split(",")[0]?.trim() ?? "";

    return IP_LIKE.test(first) ? { key: first, limit: "mcp" } : { key: "unidentified", limit: "unidentified" };
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
    const caller = callerKey(request);
    const status = await limiter.limit(caller.limit, { key: caller.key });

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
