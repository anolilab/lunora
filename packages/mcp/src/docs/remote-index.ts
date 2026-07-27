/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * A {@link DocsIndex} backed by a published Lunora docs site over plain HTTP.
 *
 * It deliberately reads the site's three long-standing public endpoints rather
 * than the MCP endpoint the same site serves:
 *
 * - `GET /api/search?query=…` — the fumadocs (Orama) search index
 * - `GET /llms.mdx/docs/&lt;slug>` — one page as Markdown
 * - `GET /llms.txt` — the page index
 *
 * That keeps a locally-run server (the CLI's `lunora mcp serve`) working
 * against any docs deployment, including older ones that predate the hosted
 * `/mcp` route, and avoids proxying MCP-over-MCP.
 *
 * Every method degrades to empty rather than throwing on a non-OK response, so
 * an offline or half-deployed docs site turns into "no results" instead of a
 * tool error the model has to interpret.
 */
import { toDocsSearchHits } from "./sorted-results";
import type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "./types";

/** The public docs site the remote index reads when no base URL is configured. */
const DEFAULT_DOCS_BASE_URL = "https://lunora.sh";

interface RemoteDocsIndexOptions {
    /** Origin of the docs site, e.g. `"https://lunora.sh"`. Defaults to {@link DEFAULT_DOCS_BASE_URL}. */
    baseUrl?: string;
    /** `fetch` implementation; defaults to the ambient global. */
    fetch?: typeof fetch;
}

/** Drop the trailing slash so `${base}${path}` never doubles it. */
const trimTrailingSlash = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);

/**
 * Parse one `llms.txt` list item — `- [Title](/docs/x): description` — into a
 * page summary, or `undefined` for any line that isn't one (headings, blank
 * lines, prose). Hand-parsed via `indexOf` rather than a regex: the input is
 * remote content, and nested brackets in a title are exactly the shape that
 * makes a naive link regex backtrack.
 */
const parseIndexLine = (line: string): DocsPageSummary | undefined => {
    const trimmed = line.trim();

    if (!trimmed.startsWith("- [")) {
        return undefined;
    }

    const linkEnd = trimmed.lastIndexOf("](");

    if (linkEnd === -1) {
        return undefined;
    }

    const urlEnd = trimmed.indexOf(")", linkEnd);

    if (urlEnd === -1) {
        return undefined;
    }

    const title = trimmed.slice(3, linkEnd).trim();
    const url = trimmed.slice(linkEnd + 2, urlEnd).trim();

    if (title.length === 0 || url.length === 0) {
        return undefined;
    }

    const rest = trimmed.slice(urlEnd + 1).trim();
    const description = rest.startsWith(":") ? rest.slice(1).trim() : "";

    return description.length > 0 ? { description, title, url } : { title, url };
};

/**
 * Strip the ` (/docs/x)` suffix `getLLMText` appends to the title line. Only a
 * parenthesized *URL* is removed — a title that legitimately ends in
 * parentheses, e.g. `Values (v.*)`, is left alone.
 */
const stripTitleUrlSuffix = (title: string): string => {
    if (!title.endsWith(")")) {
        return title;
    }

    const open = title.lastIndexOf(" (");

    if (open === -1) {
        return title;
    }

    const inner = title.slice(open + 2, -1);

    return inner.startsWith("/") || inner.startsWith("http") ? title.slice(0, open).trim() : title;
};

/** First `# Heading` in a Markdown body, used as the page title when we only have the body. */
const readMarkdownTitle = (markdown: string, fallback: string): string => {
    for (const line of markdown.split("\n")) {
        if (line.startsWith("# ")) {
            return stripTitleUrlSuffix(line.slice(2).trim());
        }

        if (line.trim().length > 0) {
            break;
        }
    }

    return fallback;
};

/**
 * Drop the `# Title (url)` header `getLLMText` prepends to every page, so the
 * body isn't duplicated under the header `lunora_get_doc` adds back.
 */
const stripLeadingTitle = (markdown: string): string => {
    if (!markdown.startsWith("# ")) {
        return markdown;
    }

    const lineEnd = markdown.indexOf("\n");

    return lineEnd === -1 ? "" : markdown.slice(lineEnd + 1).trimStart();
};

const createRemoteDocsIndex = (options: RemoteDocsIndexOptions = {}): DocsIndex => {
    const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_DOCS_BASE_URL);
    const fetchImplementation = options.fetch ?? globalThis.fetch;

    /** GET `path`, returning the body text, or `undefined` on any failure. */
    const get = async (path: string): Promise<string | undefined> => {
        try {
            const response = await fetchImplementation(`${baseUrl}${path}`, { headers: { accept: "text/plain, application/json" } });

            if (!response.ok) {
                return undefined;
            }

            return await response.text();
        } catch {
            return undefined;
        }
    };

    return {
        getPage: async (url: string): Promise<DocsPage | undefined> => {
            // `/llms.mdx` mirrors the docs tree, so the page path appends directly.
            const markdown = await get(`/llms.mdx${url}`);

            if (markdown === undefined || markdown.trim().length === 0) {
                return undefined;
            }

            return { content: stripLeadingTitle(markdown), title: readMarkdownTitle(markdown, url), url };
        },

        listPages: async (): Promise<ReadonlyArray<DocsPageSummary>> => {
            const index = await get("/llms.txt");

            if (index === undefined) {
                return [];
            }

            const pages: DocsPageSummary[] = [];

            for (const line of index.split("\n")) {
                const page = parseIndexLine(line);

                if (page !== undefined) {
                    pages.push(page);
                }
            }

            return pages;
        },

        search: async (query: string, limit: number): Promise<ReadonlyArray<DocsSearchHit>> => {
            const body = await get(`/api/search?query=${encodeURIComponent(query)}`);

            if (body === undefined) {
                return [];
            }

            let parsed: unknown;

            try {
                parsed = JSON.parse(body);
            } catch {
                return [];
            }

            return Array.isArray(parsed) ? toDocsSearchHits(parsed, limit) : [];
        },
    };
};

export type { RemoteDocsIndexOptions };
export { createRemoteDocsIndex, DEFAULT_DOCS_BASE_URL, parseIndexLine };
