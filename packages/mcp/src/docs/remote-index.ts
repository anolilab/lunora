/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * A {@link DocsIndex} backed by a published Lunora docs site over plain HTTP.
 *
 * It deliberately reads the site's three long-standing public endpoints rather
 * than the MCP endpoint the same site serves:
 *
 * - `GET /api/search?query=…` — the fumadocs (Orama) search index
 * - `GET /llms.mdx/docs/<slug>` — one page as Markdown
 * - `GET /llms.txt` — the page index
 *
 * That keeps a locally-run server (the CLI's `lunora mcp serve`) working
 * against any docs deployment, including older ones that predate the hosted
 * `/mcp` route, and avoids proxying MCP-over-MCP.
 *
 * It is therefore a CONTRACT WITH THE DOCS SITE, not just with a URL: the
 * counterparts live in `apps/docs/src/routes/api/search.ts`,
 * `llms[.]mdx.docs.$.ts` and `llms[.]txt.ts`. Change a response shape there and
 * this reader degrades silently, so keep the two in step.
 *
 * A **miss** degrades to empty, so a half-deployed docs site turns into "no
 * results" rather than a tool error the model has to interpret. Failing to
 * reach the host at all is raised instead — see `get` for why the two are worth
 * telling apart.
 */
import { toDocsSearchHits } from "./fumadocs-hits";
import type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "./types";

/** The public docs site the remote index reads when no base URL is configured. */
const DEFAULT_DOCS_BASE_URL = "https://lunora.sh";

/**
 * Deadline for a single documentation request. Without one, an unresponsive
 * docs host leaves the calling tool — and the agent waiting on it — hanging
 * indefinitely, with no way for the model to recover.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface RemoteDocsIndexOptions {
    /** Origin of the docs site, e.g. `"https://lunora.sh"`. Defaults to {@link DEFAULT_DOCS_BASE_URL}. */
    baseUrl?: string;
    /** `fetch` implementation; defaults to the ambient global. */
    fetch?: typeof fetch;
    /** Per-request deadline in ms. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
    timeoutMs?: number;
}

/** Drop the trailing slash so `${base}${path}` never doubles it. */
const trimTrailingSlash = (value: string): string => (value.endsWith("/") ? value.slice(0, -1) : value);

/** The escape character fumadocs uses in the index it writes. */
const BACKSLASH = "\\";

/**
 * Index of the first `character` at or after `from` that is NOT backslash-escaped.
 *
 * fumadocs escapes parentheses inside a link target, so a naive `indexOf(")")`
 * ends the URL at the first escaped paren and truncates it.
 */
const indexOfUnescaped = (value: string, character: string, from: number): number => {
    for (let index = from; index < value.length; index += 1) {
        if (value[index] === character && value[index - 1] !== BACKSLASH) {
            return index;
        }
    }

    return -1;
};

/** Undo the backslash escaping fumadocs applies to link titles and URLs. */
const unescapeMarkdown = (value: string): string =>
    value
        .replaceAll(String.raw`\[`, "[")
        .replaceAll(String.raw`\]`, "]")
        .replaceAll(String.raw`\(`, "(")
        .replaceAll(String.raw`\)`, ")");

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

    const urlEnd = indexOfUnescaped(trimmed, ")", linkEnd + 2);

    if (urlEnd === -1) {
        return undefined;
    }

    // fumadocs escapes `[`/`]` in titles and `(`/`)` in URLs when it writes the
    // index, so unescape before handing either to a model.
    const title = unescapeMarkdown(trimmed.slice(3, linkEnd).trim());
    const url = unescapeMarkdown(trimmed.slice(linkEnd + 2, urlEnd).trim());

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
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    /**
     * GET `path`.
     *
     * A **miss** (non-OK status) and a **failure to reach the host at all** are
     * reported differently on purpose. Collapsing both to "no results" means a
     * typo'd `--docs-url`, a DNS failure and a genuine 404 are indistinguishable
     * to the model, which can then never correct the one that is its user's
     * misconfiguration.
     */
    const get = async (path: string): Promise<{ body: string } | { missing: true } | { unreachable: string }> => {
        try {
            const response = await fetchImplementation(`${baseUrl}${path}`, {
                headers: { accept: "text/plain, application/json" },
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (!response.ok) {
                return { missing: true };
            }

            return { body: await response.text() };
        } catch (error: unknown) {
            return { unreachable: error instanceof Error ? error.message : String(error) };
        }
    };

    /** Raise a reachability failure; a miss stays a miss. */
    const bodyOrThrow = (result: Awaited<ReturnType<typeof get>>, path: string): string | undefined => {
        if ("unreachable" in result) {
            throw new Error(`could not reach the documentation site at ${baseUrl}${path}: ${result.unreachable}`);
        }

        return "missing" in result ? undefined : result.body;
    };

    return {
        getPage: async (url: string): Promise<DocsPage | undefined> => {
            // `/llms.mdx` mirrors the docs tree, so the page path appends directly.
            const markdown = bodyOrThrow(await get(`/llms.mdx${url}`), `/llms.mdx${url}`);

            if (markdown === undefined || markdown.trim().length === 0) {
                return undefined;
            }

            return { content: stripLeadingTitle(markdown), title: readMarkdownTitle(markdown, url), url };
        },

        listPages: async (): Promise<ReadonlyArray<DocsPageSummary>> => {
            const index = bodyOrThrow(await get("/llms.txt"), "/llms.txt");

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

        search: async (query: string): Promise<ReadonlyArray<DocsSearchHit>> => {
            const path = `/api/search?query=${encodeURIComponent(query)}`;
            const body = bodyOrThrow(await get(path), path);

            if (body === undefined) {
                return [];
            }

            let parsed: unknown;

            try {
                parsed = JSON.parse(body);
            } catch {
                return [];
            }

            return Array.isArray(parsed) ? toDocsSearchHits(parsed) : [];
        },
    };
};

export type { RemoteDocsIndexOptions };
export { createRemoteDocsIndex, DEFAULT_DOCS_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS, parseIndexLine };
