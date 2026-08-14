const SITE_URL = "https://lunora.sh";
const SITE_NAME = "Lunora";
const DEFAULT_DESCRIPTION =
    "Lunora gives you typed queries, mutations, and live subscriptions that sync from your Cloudflare Workers + Durable Objects backend straight to the client — with a Vite-first developer experience.";

/**
 * The site-wide social card. Content frontmatter names it as a bare path, so
 * both forms have to be recognisable: a post declaring it has *no* cover, and
 * treating it as one is how six blog entries ended up sharing an image.
 */
const OG_FALLBACK_PATH = "/og-default.jpg";
const DEFAULT_OG_IMAGE = `${SITE_URL}${OG_FALLBACK_PATH}`;

/**
 * True when `value` is not real art: absent, blank, or the shared fallback.
 *
 * The blank cases are not hypothetical. Frontmatter is typed `image?: string`
 * but never validated, and YAML gives `null` for a bare `image:` and `""` for
 * `image: ""`. Both used to pass this guard as "real", which resolved
 * `new URL("", SITE_URL)` to the homepage and put an HTML page in `og:image`.
 */
const isFallbackImage = (value?: null | string): boolean =>
    typeof value !== "string" || value.trim() === "" || value === OG_FALLBACK_PATH || value === DEFAULT_OG_IMAGE;

interface SeoOptions {
    canonical?: string;
    description?: string;
    noindex?: boolean;
    ogImage?: string;
    ogType?: "article" | "website";
    path?: string;
    title: string;
}

export const createSeoHead = (options: SeoOptions): { links: Record<string, string>[]; meta: Record<string, string>[]; title: string } => {
    const { canonical, description = DEFAULT_DESCRIPTION, noindex = false, ogImage = DEFAULT_OG_IMAGE, ogType = "website", path, title } = options;

    const fullTitle = title === SITE_NAME ? title : `${title} - ${SITE_NAME}`;
    const url = canonical ?? (path ? `${SITE_URL}${path}` : SITE_URL);

    const meta: Record<string, string>[] = [
        // The document title has to be an entry in `meta`, not a sibling of it.
        // `HeadContent` scans the meta array for the first entry carrying a
        // `title` key and renders that as <title>; a top-level `title` on the
        // head object is dropped. Spreading this helper into a route's `head()`
        // hides the mistake, because a spread is not excess-property checked, so
        // the site shipped with no <title> on any page and nothing complained.
        { title: fullTitle },
        { content: fullTitle, name: "title" },
        { content: description, name: "description" },
        // Open Graph
        { content: ogType, property: "og:type" },
        { content: url, property: "og:url" },
        { content: fullTitle, property: "og:title" },
        { content: description, property: "og:description" },
        { content: ogImage, property: "og:image" },
        { content: SITE_NAME, property: "og:site_name" },
        // Twitter Card
        { content: "summary_large_image", name: "twitter:card" },
        { content: url, name: "twitter:url" },
        { content: fullTitle, name: "twitter:title" },
        { content: description, name: "twitter:description" },
        { content: ogImage, name: "twitter:image" },
    ];

    if (noindex) {
        meta.push({ content: "noindex, nofollow", name: "robots" });
    }

    const links: Record<string, string>[] = [{ href: url, rel: "canonical" }];

    return { links, meta, title: fullTitle };
};

export const createJsonLd = (data: Record<string, unknown>): string => JSON.stringify({ "@context": "https://schema.org", ...data });

export { DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE, isFallbackImage, SITE_NAME, SITE_URL };
