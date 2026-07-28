import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/docs-source";

/**
 * The site's search index, built once per server instance.
 *
 * Two routes read it — `/api/search` (the site's own search UI) and `/mcp` (the
 * documentation MCP server) — and building an Orama index is neither free nor
 * idempotent in memory, so they share this instance rather than each calling
 * `createFromSource` themselves.
 */
export const searchServer = createFromSource(source, {
    // https://docs.orama.com/docs/orama-js/supported-languages
    language: "english",
});
