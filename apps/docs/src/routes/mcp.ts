import { createDocsMcpFetchHandler } from "@lunora/mcp/docs";
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

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

export const Route = createFileRoute("/mcp")({
    server: {
        handlers: {
            DELETE: async ({ request }) => withCors(await handle(request)),
            GET: async ({ request }) => {
                if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
                    return withCors(new Response(CONNECT_HELP, { headers: { "content-type": "text/plain; charset=utf-8" } }));
                }

                return withCors(await handle(request));
            },
            // eslint-disable-next-line unicorn/no-null -- the Response body must be null for a 204; `undefined` is not accepted by the Fetch API here.
            OPTIONS: () => new Response(null, { headers: CORS_HEADERS, status: 204 }),
            POST: async ({ request }) => withCors(await handle(request)),
        },
    },
});
