import { createCompiler } from "@fumadocs/mdx-remote";
import { executeMdxSync } from "@fumadocs/mdx-remote/client";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import defaultMdxComponents from "fumadocs-ui/mdx";

import { createSeoHead, SITE_URL } from "@/lib/seo";
import type { BlogPostMeta, PostLink, RelatedPost } from "@/pages/blog/content";
import BlogPost from "@/pages/blog/content";

import { NotFound } from "../../pages/not-found";

const compiler = createCompiler({ development: false });
const WORD_SPLIT = /\s+/;

const toLink = (post?: { slug: string; title?: string }): PostLink | null => {
    if (!post) {
        return null;
    }

    return { slug: post.slug, title: post.title };
};

const loadPost = createServerFn({ method: "GET" })
    .inputValidator((slug: string) => slug)
    .handler(async ({ data: slug }) => {
        const { listBlogPosts, source } = await import("@/lib/blog-source");
        const page = source.getPage([slug]);

        if (!page) {
            return null;
        }

        const data = page.data as BlogPostMeta & { content: string };
        const result = await compiler.compile({ source: data.content });

        const words = data.content.trim().split(WORD_SPLIT).filter(Boolean).length;
        const readingMinutes = Math.max(1, Math.round(words / 200));

        // `listBlogPosts()` is already normalised (ISO dates) and sorted newest-first.
        const all = listBlogPosts();
        const index = all.findIndex((other) => other.slug === slug);
        const newer = index > 0 ? all[index - 1] : undefined;
        const older = index >= 0 && index < all.length - 1 ? all[index + 1] : undefined;

        const related: RelatedPost[] = all
            .filter((other) => other.slug !== slug)
            .slice(0, 3)
            .map((other) => {
                return {
                    category: other.category,
                    image: other.image,
                    publishedAt: other.publishedAt,
                    slug: other.slug,
                    title: other.title,
                };
            });

        return {
            compiled: result.compiled,
            meta: {
                author: data.author,
                category: data.category,
                description: data.description,
                image: data.image,
                publishedAt: data.publishedAt ? new Date(data.publishedAt).toISOString() : undefined,
                readingMinutes,
                title: data.title,
            } satisfies BlogPostMeta,
            next: toLink(newer),
            prev: toLink(older),
            related,
        };
    });

const RouteComponent = () => {
    const { compiled, meta, next, prev, related, slug } = Route.useLoaderData();
    const { default: MdxContent, toc } = executeMdxSync(compiled);

    return (
        <BlogPost next={next} post={meta} prev={prev} related={related} slug={slug} toc={toc}>
            <MdxContent components={defaultMdxComponents} />
        </BlogPost>
    );
};

export const Route = createFileRoute("/blog/$slug")({
    component: RouteComponent,
    loader: async ({ params }) => {
        const data = await loadPost({ data: params.slug });

        if (!data) {
            throw notFound();
        }

        return { ...data, slug: params.slug };
    },
    notFoundComponent: (props) => <NotFound {...props}>That blog post could not be found, or may have been moved.</NotFound>,
    head: ({ loaderData }) => {
        if (!loaderData?.meta.title) {
            return {};
        }

        const ogParams = new URLSearchParams({
            description: loaderData.meta.description ?? "",
            eyebrow: loaderData.meta.category ?? "Blog",
            title: loaderData.meta.title,
        });

        const seo = createSeoHead({
            description: loaderData.meta.description ?? `${loaderData.meta.title} — Lunora blog`,
            // Dynamic OG image generated per post (see routes/api/og.ts).
            ogImage: `${SITE_URL}/api/og?${ogParams.toString()}`,
            ogType: "article",
            path: `/blog/${loaderData.slug}`,
            title: loaderData.meta.title,
        });

        const meta = [...seo.meta];

        if (loaderData.meta.publishedAt) {
            meta.push({ content: loaderData.meta.publishedAt, property: "article:published_time" });
        }

        if (loaderData.meta.author) {
            meta.push({ content: loaderData.meta.author, property: "article:author" });
        }

        if (loaderData.meta.category) {
            meta.push({ content: loaderData.meta.category, property: "article:section" });
        }

        return { ...seo, meta };
    },
});
