/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * Translate fumadocs search results into {@link DocsSearchHit}s.
 *
 * (Named for what it maps, not for fumadocs' `SortedResult` type — nothing here
 * sorts.)
 *
 * Both docs backends produce this shape — the docs site gets it in-process from
 * its Orama index, a remote reader gets the same objects as JSON from
 * `/api/search` — so the mapping lives here once and both call it. Keeping it
 * shared is what guarantees a model sees identical hits whichever backend
 * answered.
 *
 * The input is typed loosely on purpose: the remote path has just parsed
 * untrusted JSON, so every field is validated rather than assumed.
 */
import type { DocsSearchHit } from "./types";

/** The subset of a fumadocs `SortedResult` these tools consume. */
interface FumadocsSearchResult {
    breadcrumbs?: string[];
    content?: string;
    type?: string;
    url?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Strip the `<mark>` highlight tags fumadocs wraps around matched terms. They
 * are UI markup; leaving them in makes the model treat them as content (and
 * sometimes echo them back into generated code).
 */
const stripHighlightMarkup = (value: string): string => value.split("<mark>").join("").split("</mark>").join("");

/** The breadcrumb trail as a clean string array; anything non-string is dropped. */
const readBreadcrumbs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((crumb): crumb is string => typeof crumb === "string") : []);

/**
 * Map one result, or `undefined` when it carries no usable `url`.
 *
 * A `page` hit's `content` IS the page title; `heading`/`text` hits carry the
 * matched text instead, and their page title lives at the end of the breadcrumb
 * trail — so the two cases fill `title`/`excerpt` differently.
 */
const toDocsSearchHit = (entry: unknown): DocsSearchHit | undefined => {
    if (!isObject(entry) || typeof entry.url !== "string" || entry.url.length === 0) {
        return undefined;
    }

    const result = entry as FumadocsSearchResult;
    const content = typeof result.content === "string" ? stripHighlightMarkup(result.content) : "";
    const breadcrumbs = readBreadcrumbs(result.breadcrumbs);
    const isPage = result.type === "page";
    const title = isPage ? content : (breadcrumbs.at(-1) ?? content);

    return {
        ...(isPage || content.length === 0 ? {} : { excerpt: content }),
        ...(breadcrumbs.length > 0 ? { section: breadcrumbs.join(" › ") } : {}),
        title: title.length > 0 ? title : entry.url,
        url: entry.url,
    };
};

/** Map every result, skipping any entry {@link toDocsSearchHit} rejects. */
const toDocsSearchHits = (results: ReadonlyArray<unknown>): DocsSearchHit[] => {
    const hits: DocsSearchHit[] = [];

    for (const entry of results) {
        const hit = toDocsSearchHit(entry);

        if (hit !== undefined) {
            hits.push(hit);
        }
    }

    return hits;
};

export type { FumadocsSearchResult };
export { toDocsSearchHits };
