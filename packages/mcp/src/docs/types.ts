/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_search_docs` / `lunora_get_doc` / `lunora_list_docs` tool names. Renaming the identifiers to "documentation" would diverge from the names callers and models actually use. */

/**
 * The documentation source the docs tools read.
 *
 * The tools are written against this interface rather than against a concrete
 * search engine so the same tool surface can be backed two ways: in-process by
 * the docs site itself (fumadocs `source` + its Orama index), or over HTTP by a
 * remote reader that only has the published site (see `./remote-index`). Both
 * expose the identical tool names and result shapes to the model.
 */

/** One hit from {@link DocsIndex.search}. */
interface DocsSearchHit {
    /** The matched text, when the backend returns one (headings/paragraph hits). */
    excerpt?: string;
    /** Breadcrumb trail to the matched section, e.g. `"Guides › Sharding"`. */
    section?: string;
    /** Page title. */
    title: string;
    /** Site-relative page URL, e.g. `"/docs/sharding"` — feed this to `lunora_get_doc`. */
    url: string;
}

/** A page listed by {@link DocsIndex.listPages}. */
interface DocsPageSummary {
    description?: string;
    title: string;
    /** Site-relative page URL, e.g. `"/docs/sharding"`. */
    url: string;
}

/** A page's full text, as returned by {@link DocsIndex.getPage}. */
interface DocsPage extends DocsPageSummary {
    /** The page body as Markdown. */
    content: string;
}

interface DocsIndex {
    /**
     * The page at a site-relative URL, or `undefined` when there is no such
     * page. Implementations should accept the URL exactly as it appears in a
     * search hit.
     */
    getPage: (url: string) => Promise<DocsPage | undefined>;

    /** Every indexed page, for a model that wants to browse rather than search. */
    listPages: () => Promise<ReadonlyArray<DocsPageSummary>>;

    /**
     * Full-text search, returning whatever the backend found.
     *
     * Deliberately unbounded: the tool layer decides how many hits reach the
     * model's context, so there is one truncation site rather than one per
     * backend plus one in the tool.
     */
    search: (query: string) => Promise<ReadonlyArray<DocsSearchHit>>;
}

export type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit };
