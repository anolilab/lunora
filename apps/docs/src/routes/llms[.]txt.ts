import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";

import { source } from "@/lib/docs-source";

/**
 * Point agents at the live endpoint, not just the page index.
 *
 * `llms.txt` is the one file a coding agent reliably fetches from a docs site,
 * which makes it the right place to say "there is an MCP server here." Without
 * it the endpoint is only discoverable by reading the docs — which is precisely
 * the thing an agent is trying to avoid doing one page at a time.
 */
const MCP_NOTICE = `## Model Context Protocol

This documentation is also served over MCP at https://lunora.sh/mcp — an
unauthenticated Streamable HTTP endpoint exposing \`lunora_search_docs\`,
\`lunora_get_doc\` and \`lunora_list_docs\`. Prefer it over crawling these pages:
search returns the relevant sections directly.

    claude mcp add --transport http lunora-docs https://lunora.sh/mcp

Or run \`lunora mcp install\` inside a project to wire it into your editor
alongside that project's own Lunora server.

`;

export const Route = createFileRoute("/llms.txt")({
    server: {
        handlers: {
            GET() {
                return new Response(`${MCP_NOTICE}${llms(source).index()}`);
            },
        },
    },
});
