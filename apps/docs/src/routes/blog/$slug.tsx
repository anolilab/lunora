import { executeMdxSync } from "@fumadocs/mdx-remote/client";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { ComponentProps } from "react";

import { createSeoHead, SITE_URL } from "@/lib/seo";
import type { BlogPostMeta, PostLink, RelatedPost } from "@/pages/blog/content";
import BlogPost from "@/pages/blog/content";

import { NotFound } from "../../pages/not-found";

const WORD_SPLIT = /\s+/;

const toLink = (post?: { slug: string; title?: string }): PostLink | null => {
    if (!post) {
        return null;
    }

    return { slug: post.slug, title: post.title };
};

const buildPost = async (slug: string) => {
    const { getCompiledPost, listBlogPosts } = await import("@/lib/blog-source");
    const post = await getCompiledPost(slug);

    if (!post) {
        return null;
    }

    const { data } = post;
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
        compiled: post.mdx,
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
};

const loadPost = createServerFn({ method: "GET" })
    .inputValidator((slug: string) => slug)
    .handler(({ data: slug }) => buildPost(slug));

const BaseImg = defaultMdxComponents.img;

// Inline post images sit below the fold; lazy-load them so they don't compete
// with the initial render. `defaultMdxComponents.img` is fumadocs' Image wrapper;
// spreading props last preserves remarkImage's width/height and the alt text.
const mdxComponents = {
    ...defaultMdxComponents,
    img: (props: ComponentProps<"img">) => <BaseImg decoding="async" loading="lazy" {...props} />,
};

const RouteComponent = () => {
    const { compiled, meta, next, prev, related, slug } = Route.useLoaderData();
    const { default: MdxContent, toc } = executeMdxSync(compiled);

    return (
        <BlogPost next={next} post={meta} prev={prev} related={related} slug={slug} toc={toc}>
            <MdxContent components={mdxComponents} />
        </BlogPost>
    );
};

export const Route = createFileRoute("/blog/$slug")({
    component: RouteComponent,
    // Posts are static for the life of a deployment (compiled MDX is memoised in
    // blog-source), so don't re-run the loader on client-side navigation.
    staleTime: Number.POSITIVE_INFINITY,
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

        const ogParameters = new URLSearchParams({
            description: loaderData.meta.description ?? "",
            eyebrow: loaderData.meta.category ?? "Blog",
            title: loaderData.meta.title,
        });

        const seo = createSeoHead({
            description: loaderData.meta.description ?? `${loaderData.meta.title} — Lunora blog`,
            // Dynamic OG image generated per post (see routes/api/og.ts).
            ogImage: `${SITE_URL}/api/og?${ogParameters.toString()}`,
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
