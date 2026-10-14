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

interface CompiledPost {
    data: BlogFrontmatter;
    mdx: string;
}

// Compiling MDX is the expensive part of loading a post — shiki (via rehypeCode)
// re-highlights on every call. The compiler is heavy, so load it lazily; this
// keeps list-only consumers (the index route, RSS, sitemap) from bundling it.
//
// `onError: "ignore"` on remarkImage is required: it reads each image off the
// filesystem (`./public`) to inject width/height, but the deployed server
// function runs with a different cwd and doesn't ship the static assets, so the
// read fails at runtime. Ignoring it lets the post compile (the image still
// renders, just without baked dimensions) instead of throwing. The prerendered
// build still bakes dimensions in because cwd is the app root there.
const loadCompiler = async () => {
    const { createCompiler } = await import("@fumadocs/mdx-remote");

    return createCompiler({ development: false, remarkImageOptions: { onError: "ignore" } });
};

let compilerPromise: ReturnType<typeof loadCompiler> | undefined;

// Blog content is bundled per deployment (see the import.meta.glob note above)
// and therefore static, so compile each post at most once and reuse it. Only
// real posts are cached, so requests for unknown slugs can't grow the map.
const compiledPosts = new Map<string, CompiledPost>();

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

/**
 * Compile a post's MDX to its renderable form, memoised by slug. Returns
 * undefined for an unknown slug (without caching it). Server-only.
 */
export const getCompiledPost = async (slug: string): Promise<CompiledPost | undefined> => {
    const cached = compiledPosts.get(slug);

    if (cached) {
        return cached;
    }

    const page = source.getPage([slug]);

    if (!page) {
        return undefined;
    }

    const data = page.data as BlogFrontmatter;

    compilerPromise ??= loadCompiler();

    const compiler = await compilerPromise;
    const { compiled } = await compiler.compile({ source: data.content });
    const entry: CompiledPost = { data, mdx: compiled };

    compiledPosts.set(slug, entry);

    return entry;
};
