import { extname, join, relative } from "node:path";

import type { MetaData, PageData, Source, VirtualFile } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import matter from "gray-matter";

// Vite statically replaces this `import.meta.glob(...)` call with a record of
// the matched files at build time, so the bundled server/function carries the
// content inline and never reads the filesystem at runtime.
//
// Do NOT gate this behind a `typeof import.meta.glob === "function"` runtime
// check: Vite rewrites the call but leaves the bare reference, which is
// `undefined` at runtime — so the guard is always false in the built output and
// would fall through to a filesystem read that finds nothing in a deployed
// function (the cause of blog posts 404-ing on client-side navigation).
const files: [string, string][] = Object.entries(
    import.meta.glob<true, "raw">("/src/content/blog/**/*", {
        eager: true,
        import: "default",
        query: "?raw",
    }),
);

const virtualFiles: VirtualFile[] = files.flatMap(([file, content]): VirtualFile[] => {
    const extension = extname(file);
    const virtualPath = relative("src/content/blog", join(process.cwd(), file));

    if (extension === ".mdx" || extension === ".md") {
        const parsed = matter(content);

        return [
            {
                data: {
                    ...parsed.data,
                    content: parsed.content,
                } as PageData,
                path: virtualPath,
                type: "page",
            },
        ];
    }

    if (extension === ".json") {
        return [
            {
                data: JSON.parse(content) as MetaData,
                path: virtualPath,
                type: "meta",
            },
        ];
    }

    return [];
});

const toTime = (value?: string): number => {
    if (value === undefined) {
        return 0;
    }

    return new Date(value).getTime();
};

export interface BlogFrontmatter {
    author?: string;
    category?: string;
    content: string;
    description?: string;
    image?: string;
    publishedAt?: string;
    tags?: string[];
    title?: string;
}

export const source = loader({
    baseUrl: "/blog",
    source: {
        files: virtualFiles,
    } as Source<{
        metaData: MetaData;
        pageData: BlogFrontmatter & PageData;
    }>,
});

export interface BlogPostSummary {
    author?: string;
    category?: string;
    description?: string;
    image?: string;
    publishedAt?: string;
    slug: string;
    title?: string;
}

/**
 * All blog posts as normalised summaries (ISO dates), sorted newest-first.
 * The single source of truth for the list, RSS feed, sitemap, and per-post
 * prev/next/related — server-only (reads the file-backed source).
 */
export const listBlogPosts = (): BlogPostSummary[] =>
    source
        .getPages()
        .map((page): BlogPostSummary => {
            const data = page.data as Omit<BlogPostSummary, "slug">;

            return {
                author: data.author,
                category: data.category,
                description: data.description,
                image: data.image,
                publishedAt: data.publishedAt ? new Date(data.publishedAt).toISOString() : undefined,
                slug: page.slugs.join("/"),
                title: data.title,
            };
        })
        .toSorted((a, b) => toTime(b.publishedAt) - toTime(a.publishedAt));
