/**
 * `@lunora/mcp/docs` — the documentation tool surface: `lunora_search_docs`,
 * `lunora_get_doc`, and `lunora_list_docs`.
 *
 * Where the package's main entry exposes a deployment to an agent (its
 * functions and data, behind an admin token), this entry exposes the
 * framework's documentation, so an agent writing Lunora code can look up the
 * real API instead of inventing one. It reads published docs only — no
 * credentials, no writes — so a server built from it is safe to host
 * unauthenticated.
 *
 * Two backends implement the same `DocsIndex` contract: a docs site wires up
 * its own in-process search index, while anything else (the CLI's
 * `lunora mcp serve`, a script) uses `createRemoteDocsIndex` to read a
 * published site over HTTP.
 *
 * This entry is free of Node built-ins and of `@lunora/client`, so it runs on
 * Workers, Netlify/Vercel functions, Deno, and Bun unchanged —
 * `scripts/check-dist-production.js` asserts that against the emitted chunks.
 *
 * Only the documentation surface lives here. The generic composition primitive
 * (`createToolServer`) is exported from the package root, so a consumer using
 * both entries gets one implementation rather than two copies.
 */
export type { McpResourceProvider, McpResourceSummary, McpServerInfo, McpTool } from "../compose";
export type { McpFetchHandler } from "../serve-stateless";
export type { ToolDefinition, ToolInputSchema, ToolResult } from "../tool-types";
export type { FumadocsSearchResult } from "./fumadocs-hits";
export { toDocsSearchHits } from "./fumadocs-hits";
export type { RemoteDocsIndexOptions } from "./remote-index";
export { createRemoteDocsIndex, DEFAULT_DOCS_BASE_URL } from "./remote-index";
export { DOCS_URI_SCHEME, docsResources, fromDocsUri, toDocsUri } from "./resources";
export type { DocsMcpServerOptions } from "./server";
export { createDocsMcpFetchHandler, createDocsMcpServer, DOCS_SERVER_NAME } from "./server";
export { DEFAULT_SEARCH_LIMIT, DOCS_TOOL_DEFINITIONS, docsTools, MAX_SEARCH_LIMIT, normalizeDocUrl } from "./tools";
export type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "./types";
