/* eslint-disable unicorn/prevent-abbreviations -- "docs" is public API here: the `@lunora/mcp/docs` subpath and the `lunora_*_docs` tool names. */

/**
 * The documentation corpus as MCP **resources**.
 *
 * The same pages the tools search are also worth exposing as documents a client
 * can enumerate and attach itself. The two are for different moments: a model
 * calls `lunora_search_docs` when it decides it needs something, while a user
 * browsing their editor's resource picker can drop "Sharding" into the context
 * without anyone guessing a query first.
 *
 * URIs are `lunora-docs:` over the page's site-relative path, so they are stable
 * across docs deployments and can't be confused for a fetchable URL.
 */
import type { McpResourceProvider, McpResourceSummary } from "../compose";
import { normalizeDocUrl } from "./tools";
import type { DocsIndex } from "./types";

/** URI scheme identifying a Lunora documentation page. */
const DOCS_URI_SCHEME = "lunora-docs:";

/** `"/docs/sharding"` → `"lunora-docs:/docs/sharding"`. */
const toDocsUri = (url: string): string => `${DOCS_URI_SCHEME}${url}`;

/** The inverse, or `undefined` for a uri this provider does not own. */
const fromDocsUri = (uri: string): string | undefined => (uri.startsWith(DOCS_URI_SCHEME) ? uri.slice(DOCS_URI_SCHEME.length) : undefined);

/** Expose `index`'s pages as listable, readable resources. */
const docsResources = (index: DocsIndex): McpResourceProvider => {
    return {
        list: async (): Promise<ReadonlyArray<McpResourceSummary>> => {
            const pages = await index.listPages();

            return pages.map((page) => {
                return {
                    ...(page.description === undefined ? {} : { description: page.description }),
                    mimeType: "text/markdown",
                    name: page.title,
                    uri: toDocsUri(page.url),
                };
            });
        },

        /**
         * A resource uri is client-supplied, so its path gets the same
         * treatment `lunora_get_doc` gives a model-supplied one: `normalizeDocUrl`
         * throws on a `..` segment, literal or percent-encoded, before the path
         * reaches an index that appends it to a URL. Sharing the tool's guard
         * rather than repeating its checks here is the point — this resource
         * path shipped as the sibling caller that had no guard at all.
         */
        read: async (uri: string): Promise<{ mimeType?: string; text: string } | undefined> => {
            const raw = fromDocsUri(uri);

            if (raw === undefined) {
                return undefined;
            }

            const page = await index.getPage(normalizeDocUrl(raw));

            return page === undefined ? undefined : { mimeType: "text/markdown", text: `# ${page.title} (${page.url})\n\n${page.content}` };
        },
    };
};

export { DOCS_URI_SCHEME, docsResources, fromDocsUri, toDocsUri };
