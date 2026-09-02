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

/** The path segment the documentation lives under, used to expand a bare slug. */
const DOCS_BASE_SEGMENT = "docs";

/** Ceiling on pages returned by `lunora_list_docs` in one call. */
const MAX_LISTED_PAGES = 500;

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

/** Every documentation tool reads published docs over the network and changes nothing. */
const READ_ONLY_DOCS_ANNOTATIONS = { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true } as const;

const SEARCH_TOOL_DEFINITION: ToolDefinition = {
    annotations: { ...READ_ONLY_DOCS_ANNOTATIONS, title: "Search the Lunora documentation" },
    description:
        "Search the Lunora documentation and return matching pages and sections. Use this before writing Lunora code (schema, queries, mutations, actions, sharding, .global(), client hooks) so the answer reflects the framework's current API rather than a guess. Follow a hit with lunora_get_doc to read the full page.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    name: "lunora_search_docs",
};

const GET_DOC_TOOL_DEFINITION: ToolDefinition = {
    annotations: { ...READ_ONLY_DOCS_ANNOTATIONS, title: "Read a Lunora documentation page" },
    description: "Return one Lunora documentation page in full, as Markdown. Takes the `url` of a lunora_search_docs hit or a lunora_list_docs entry.",
    inputSchema: GET_DOC_INPUT_SCHEMA,
    name: "lunora_get_doc",
};

const LIST_DOCS_TOOL_DEFINITION: ToolDefinition = {
    annotations: { ...READ_ONLY_DOCS_ANNOTATIONS, title: "List the Lunora documentation pages" },
    description: "List every Lunora documentation page with its title and description. Prefer lunora_search_docs when you know what you're looking for.",
    inputSchema: NO_INPUT_SCHEMA,
    name: "lunora_list_docs",
};

/** The advertised surface, in the order a caller should reach for it. */
const DOCS_TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = [SEARCH_TOOL_DEFINITION, GET_DOC_TOOL_DEFINITION, LIST_DOCS_TOOL_DEFINITION];

const ok = (value: unknown): ToolResult => {
    return { content: [{ text: JSON.stringify(value, undefined, 2), type: "text" }] };
};

const fail = (message: string): ToolResult => {
    return { content: [{ text: message, type: "text" }], isError: true };
};

/**
 * Longest accepted string argument.
 *
 * A search query is a handful of words; a page URL is a short path. The cap
 * exists because this surface is hosted unauthenticated, and an unbounded
 * `query` is a free way to make the search engine do arbitrary work — the
 * pre-existing `GET /api/search` was capped by URL length, and moving search
 * behind a POST body removed that ceiling.
 */
const MAX_ARGUMENT_LENGTH = 512;

/** Read a required, non-empty, bounded string argument out of an MCP `arguments` bag. */
const readStringArgument = (input: Record<string, unknown>, key: string): string => {
    const value = input[key];

    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`"${key}" is required and must be a non-empty string`);
    }

    if (value.length > MAX_ARGUMENT_LENGTH) {
        throw new RangeError(`"${key}" must be at most ${String(MAX_ARGUMENT_LENGTH)} characters`);
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
 * Reject `..`/`.` segments whether literal or percent-encoded. A residual `%`
 * after one decode means double-encoding (`%252e`) — rejected too, since no
 * documented slug contains a percent sign.
 *
 * DECODE FIRST, SPLIT SECOND. Splitting the raw string on `/` and decoding each
 * piece only sees the separators that arrived literally, so a traversal whose
 * separator is itself encoded (`%2e%2e%2fapi`) is one "segment" that decodes to
 * `../api` — never equal to `..`, and waved straight through. The URL parser at
 * fetch time decodes and splits in that order, so this must too.
 *
 * A decoded backslash is rejected outright: `normalizeDocUrl` has already
 * folded literal backslashes into `/` (they are path separators to the URL
 * parser), so one surviving here arrived percent-encoded, and no documented
 * slug contains a backslash.
 */
const assertNoDotSegments = (value: string, raw: string): void => {
    let decoded: string;

    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw new RangeError(`"url" contains a malformed percent-escape: ${raw}`);
    }

    if (decoded.includes("%") || decoded.includes("\\")) {
        throw new RangeError(`"url" must not contain ".." or encoded segments: ${raw}`);
    }

    for (const segment of decoded.split("/")) {
        if (segment === ".." || segment === ".") {
            throw new RangeError(`"url" must not contain ".." or encoded segments: ${raw}`);
        }
    }
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
 *
 * A `..` segment is REJECTED rather than resolved. The remote backend appends
 * this path to `/llms.mdx`, so `../../api/search` would walk back out of the
 * documentation tree and pull an unrelated path on the docs origin into the
 * model's context — harmless against a public site, less so against the
 * internal host a self-hosted `--docs-url` may point at. Percent-encoded
 * forms (`%2e%2e`, doubled `%252e`) are rejected the same way: WHATWG URL
 * parsing at fetch time decodes and collapses them into the very traversal
 * the literal check would have caught.
 */
const normalizeDocUrl = (raw: string): string => {
    // Fold backslashes into `/` FIRST: WHATWG URL parsing treats them as path
    // separators for special schemes, so `docs/..\..\admin` collapses exactly
    // like `docs/../../admin` once `fetch` parses the concatenated URL. Folding
    // up front means the traversal guard below — and the value we hand back —
    // see the same path the parser will.
    let value = raw.trim().replaceAll("\\", "/");

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

    // A bare slug is the model's own shorthand for a docs page, so resolve it
    // into the documented namespace rather than to a site-root path that will
    // never match. `docs/x` is already namespaced; `x` is not.
    if (!value.startsWith("/")) {
        value = value.startsWith("docs/") ? `/${value}` : `/${DOCS_BASE_SEGMENT}/${value}`;
    }

    assertNoDotSegments(value, raw);

    return value;
};

/**
 * The documentation surface, bound to `index`.
 *
 * Each tool carries its own handler rather than routing through a shared
 * `switch`: `createToolServer` already dispatches by name, so a second switch
 * here would be a duplicate table with an unreachable `default`. It also owns
 * the throw-to-`isError` conversion, so these handlers signal argument problems
 * by throwing and return `isError` only for the expected misses a model should
 * read and act on.
 */
const docsTools = (index: DocsIndex): ReadonlyArray<McpTool> => [
    {
        definition: SEARCH_TOOL_DEFINITION,
        handle: async (input: Record<string, unknown>): Promise<ToolResult> => {
            const query = readStringArgument(input, "query");
            const limit = readLimit(input.limit);
            // Truncation happens here and nowhere else: `DocsIndex.search` returns
            // whatever its backend found, so there is one place that decides how
            // much of it reaches the model's context.
            const found = await index.search(query);
            const hits = found.slice(0, limit);

            if (hits.length === 0) {
                return ok({ hits: [], note: `no documentation matched "${query}" — try fewer or more general terms, or lunora_list_docs to browse` });
            }

            return ok({ hits });
        },
    },
    {
        definition: GET_DOC_TOOL_DEFINITION,
        handle: async (input: Record<string, unknown>): Promise<ToolResult> => {
            const url = normalizeDocUrl(readStringArgument(input, "url"));
            const page = await index.getPage(url);

            if (page === undefined) {
                return fail(`documentation page not found: ${url}. Use lunora_search_docs or lunora_list_docs to find a valid url.`);
            }

            // Returned as raw Markdown, not JSON: the body is the payload, and
            // JSON-escaping a whole page burns context and makes the fenced code
            // samples in it harder for the model to reuse.
            return { content: [{ text: `# ${page.title} (${page.url})\n\n${page.content}`, type: "text" }] };
        },
    },
    {
        definition: LIST_DOCS_TOOL_DEFINITION,
        handle: async (): Promise<ToolResult> => {
            const pages = await index.listPages();

            // Bounded like the search results, and for the same reason: this is
            // the one tool that serialises the whole corpus in a single call, so
            // an unbounded list is both a context hazard for the model and the
            // largest response an anonymous caller can ask a hosted server for.
            if (pages.length > MAX_LISTED_PAGES) {
                return ok({
                    note: `showing the first ${String(MAX_LISTED_PAGES)} of ${String(pages.length)} pages — use lunora_search_docs to find the rest`,
                    pages: pages.slice(0, MAX_LISTED_PAGES),
                });
            }

            return ok(pages);
        },
    },
];

export { DEFAULT_SEARCH_LIMIT, DOCS_TOOL_DEFINITIONS, docsTools, MAX_ARGUMENT_LENGTH, MAX_LISTED_PAGES, MAX_SEARCH_LIMIT, normalizeDocUrl };
