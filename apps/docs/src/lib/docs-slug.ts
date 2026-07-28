/**
 * The docs loader is mounted at `/docs`, so a site-relative page URL has to be
 * converted into the slug array `source.getPage` expects.
 *
 * Its own module, rather than living beside the `DocsIndex` that uses it,
 * because that index imports the fumadocs content pipeline — which means the
 * one piece of real logic in it could not otherwise be tested without standing
 * the whole pipeline up.
 */

/** The path segment the documentation is mounted under. */
const DOCS_BASE = "/docs";

/**
 * `"/docs/guides/sharding"` → `["guides", "sharding"]`.
 *
 * Matches `/docs` as a whole segment, not a prefix: `/docsomething` is not
 * under the docs tree and must not be sliced into `["omething"]`.
 */
export const slugsFor = (url: string): string[] => {
    const withoutBase = url === DOCS_BASE || url.startsWith(`${DOCS_BASE}/`) ? url.slice(DOCS_BASE.length) : url;

    return withoutBase.split("/").filter((segment) => segment.length > 0);
};
