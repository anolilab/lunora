import type { DocsIndex, DocsPage, DocsPageSummary, DocsSearchHit } from "@lunora/mcp/docs";
import { toDocsSearchHits } from "@lunora/mcp/docs";

import { source } from "@/lib/docs-source";
import { searchServer } from "@/lib/search-server";

/**
 * The site's own content as a `DocsIndex`, so the `/mcp` route can serve the
 * documentation tools straight out of this process — the same Orama index the
 * search box queries, and the same MDX the pages render. No HTTP hop, and no
 * second copy of the corpus to keep in sync.
 */

/**
 * Turn a site-relative page URL into the slug array `source.getPage` expects:
 * `"/docs/guides/sharding"` → `["guides", "sharding"]`. The docs loader is
 * mounted at `/docs`, so that prefix is the base, not part of the slug.
 */
const slugsFor = (url: string): string[] => {
    const withoutBase = url.startsWith("/docs") ? url.slice("/docs".length) : url;

    return withoutBase.split("/").filter((segment) => segment.length > 0);
};

export const mcpDocsIndex: DocsIndex = {
    getPage: async (url: string): Promise<DocsPage | undefined> => {
        const page = source.getPage(slugsFor(url));

        if (!page) {
            return undefined;
        }

        // `getText("processed")` is the same body `/llms.mdx/*` serves — MDX
        // compiled down to plain Markdown, with the components stripped.
        const content = await page.data.getText("processed");
        const { description } = page.data;

        return {
            content,
            ...(typeof description === "string" && description.length > 0 ? { description } : {}),
            title: page.data.title,
            url: page.url,
        };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- the DocsIndex contract is Promise-returning; the fumadocs source answers synchronously, unlike the remote backend this interface also serves.
    listPages: async (): Promise<ReadonlyArray<DocsPageSummary>> =>
        source.getPages().map((page) => {
            const { description } = page.data;

            return {
                ...(typeof description === "string" && description.length > 0 ? { description } : {}),
                title: page.data.title,
                url: page.url,
            };
        }),

    search: async (query: string, limit: number): Promise<ReadonlyArray<DocsSearchHit>> => toDocsSearchHits(await searchServer.search(query), limit),
};
