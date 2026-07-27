/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * The documentation tool surface: search the Lunora docs, and read a page in
 * full. Unlike the deployment tools these touch no user data and need no
 * credentials — they read published documentation — so a server built from them
 * alone is safe to expose unauthenticated.
 *
 * Definitions and dispatch live here, parameterized over {@link DocsIndex}, so
 * both backends (in-process fumadocs, remote HTTP) get identical behaviour and
 * the behaviour is unit-testable against a stub index.
 */
import type { McpTool } from "../compose";
import type { ToolDefinition, ToolInputSchema, ToolResult } from "../tool-types";
import type { DocsIndex } from "./types";

/** Hits returned when the caller doesn't ask for a specific number. */
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Ceiling on hits per call. Search results are pasted into the model's context
 * verbatim, so an unbounded `limit` is a context-exhaustion foot-gun rather
 * than a useful option.
 */
const MAX_SEARCH_LIMIT = 50;

const SEARCH_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        limit: { description: `Maximum hits to return (default ${String(DEFAULT_SEARCH_LIMIT)}, max ${String(MAX_SEARCH_LIMIT)})`, type: "number" },
        query: { description: 'Search terms, e.g. "shardBy" or "optimistic updates"', type: "string" },
    },
    required: ["query"],
    type: "object",
};

const GET_DOC_INPUT_SCHEMA: ToolInputSchema = {
    properties: {
        url: { description: 'Site-relative page URL from a search hit, e.g. "/docs/sharding"', type: "string" },
    },
    required: ["url"],
    type: "object",
};

const NO_INPUT_SCHEMA: ToolInputSchema = { properties: {}, type: "object" };

const DOCS_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [
    {
        description:
            "Search the Lunora documentation and return matching pages and sections. Use this before writing Lunora code (schema, queries, mutations, actions, sharding, .global(), client hooks) so the answer reflects the framework's current API rather than a guess. Follow a hit with lunora_get_doc to read the full page.",
        inputSchema: SEARCH_INPUT_SCHEMA,
        name: "lunora_search_docs",
    },
    {
        description: "Return one Lunora documentation page in full, as Markdown. Takes the `url` of a lunora_search_docs hit or a lunora_list_docs entry.",
        inputSchema: GET_DOC_INPUT_SCHEMA,
        name: "lunora_get_doc",
    },
    {
        description: "List every Lunora documentation page with its title and description. Prefer lunora_search_docs when you know what you're looking for.",
        inputSchema: NO_INPUT_SCHEMA,
        name: "lunora_list_docs",
    },
];

/** Names of the tools in {@link DOCS_TOOL_DEFINITIONS}, for callers filtering a composed surface. */
const DOCS_TOOL_NAMES: ReadonlySet<string> = new Set(DOCS_TOOL_DEFINITIONS.map((tool) => tool.name));

const ok = (value: unknown): ToolResult => {
    return { content: [{ text: JSON.stringify(value, undefined, 2), type: "text" }] };
};

const fail = (message: string): ToolResult => {
    return { content: [{ text: message, type: "text" }], isError: true };
};

/** Read a required non-empty string argument out of an MCP `arguments` bag. */
const readStringArgument = (input: Record<string, unknown>, key: string): string => {
    const value = input[key];

    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`"${key}" is required and must be a non-empty string`);
    }

    return value.trim();
};

/**
 * Clamp the requested hit count into `[1, MAX_SEARCH_LIMIT]`. A missing, NaN,
 * or non-numeric `limit` falls back to the default rather than erroring: the
 * argument is an optional convenience and models routinely send it as a
 * numeric string.
 */
const readLimit = (raw: unknown): number => {
    const parsed = typeof raw === "string" ? Number(raw) : raw;

    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return DEFAULT_SEARCH_LIMIT;
    }

    return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(parsed)));
};

/**
 * Normalize whatever a model passes as a page URL into the site-relative form
 * an index stores.
 *
 * Models copy URLs from anywhere — a search hit (`/docs/sharding`), the browser
 * (`https://lunora.sh/docs/sharding`), or their own memory of the slug
 * (`sharding`, `docs/sharding`). All four are the same page, and failing three
 * of them would push the model into a guess-and-retry loop, so resolve them to
 * one form. A trailing slash is dropped for the same reason.
 */
const normalizeDocumentUrl = (raw: string): string => {
    let value = raw.trim();

    // Strip an absolute origin: everything through the host, keeping the path.
    if (value.startsWith("http://") || value.startsWith("https://")) {
        const afterScheme = value.slice(value.indexOf("//") + 2);
        const slash = afterScheme.indexOf("/");

        value = slash === -1 ? "/" : afterScheme.slice(slash);
    }

    // Drop query/hash — a heading anchor still identifies the same page.
    for (const separator of ["?", "#"]) {
        const index = value.indexOf(separator);

        if (index !== -1) {
            value = value.slice(0, index);
        }
    }

    while (value.endsWith("/") && value.length > 1) {
        value = value.slice(0, -1);
    }

    if (!value.startsWith("/")) {
        value = `/${value}`;
    }

    return value;
};

/**
 * Dispatch a documentation tool call against `index`. Unknown tools and thrown
 * errors come back as `isError` results rather than rejections, so the calling
 * model sees the failure as tool output it can correct.
 */
const callDocsTool = async (index: DocsIndex, name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    try {
        switch (name) {
            case "lunora_get_doc": {
                const url = normalizeDocumentUrl(readStringArgument(input, "url"));
                const page = await index.getPage(url);

                if (page === undefined) {
                    return fail(`documentation page not found: ${url}. Use lunora_search_docs or lunora_list_docs to find a valid url.`);
                }

                // Returned as raw Markdown, not JSON: the body is the payload,
                // and JSON-escaping a whole page burns context and makes the
                // fenced code samples in it harder for the model to reuse.
                return { content: [{ text: `# ${page.title} (${page.url})\n\n${page.content}`, type: "text" }] };
            }
            case "lunora_list_docs": {
                return ok(await index.listPages());
            }
            case "lunora_search_docs": {
                const query = readStringArgument(input, "query");
                const limit = readLimit(input.limit);
                const hits = await index.search(query, limit);

                if (hits.length === 0) {
                    return ok({ hits: [], note: `no documentation matched "${query}" — try fewer or more general terms, or lunora_list_docs to browse` });
                }

                return ok({ hits: hits.slice(0, limit) });
            }
            default: {
                return fail(`unknown tool: ${name}`);
            }
        }
    } catch (error: unknown) {
        return fail(error instanceof Error ? error.message : String(error));
    }
};

/** The documentation surface as composable {@link McpTool}s bound to `index`. */
const docsTools = (index: DocsIndex): ReadonlyArray<McpTool> =>
    DOCS_TOOL_DEFINITIONS.map((definition) => {
        return {
            definition,
            handle: async (input: Record<string, unknown>): Promise<ToolResult> => callDocsTool(index, definition.name, input),
        };
    });

export { callDocsTool, DEFAULT_SEARCH_LIMIT, DOCS_TOOL_DEFINITIONS, DOCS_TOOL_NAMES, docsTools, MAX_SEARCH_LIMIT, normalizeDocumentUrl as normalizeDocUrl };
