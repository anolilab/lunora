import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import type { TOCItemType } from "fumadocs-core/toc";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXContent } from "mdx/types";
import type { ComponentProps } from "react";
import { use } from "react";

import { coverImageUrl, createSeoHead, SITE_URL } from "@/lib/seo";
import type { BlogPostMeta, PostLink, RelatedPost } from "@/pages/blog/content";
import BlogPost from "@/pages/blog/content";

import { NotFound } from "../../pages/not-found";

interface PostBody {
    default: MDXContent;
    toc: TOCItemType[];
}

// Compiled to components at build time by the fumadocs-mdx Vite plugin, one chunk
// per post. Compiling at request time and running the result needs `new Function`,
// which workerd forbids, so every post page answered 500 on the Worker.
const postBodies = import.meta.glob<PostBody>("/src/content/blog/*.{md,mdx}");
const loadedBodies = new Map<string, Promise<PostBody>>();

/**
 * The post's compiled body, imported once per slug. The loader awaits it so the
 * server render reads it without suspending; on hydration the loader does not
 * run, so the component suspends until the chunk arrives and React keeps the
 * server HTML meanwhile.
 */
const loadBody = (slug: string): Promise<PostBody> => {
    const cached = loadedBodies.get(slug);

    if (cached) {
        return cached;
    }

    // blog-source lists `.md` posts too, so a body glob of `.mdx` alone would 404 them.
    const mdxPath = `/src/content/blog/${slug}.mdx`;
    const path = Object.hasOwn(postBodies, mdxPath) ? mdxPath : `/src/content/blog/${slug}.md`;

    if (!Object.hasOwn(postBodies, path)) {
        throw notFound();
    }

    const tracked = postBodies[path]().then(
        (body) => {
            // React's `use()` reads a promise carrying these synchronously instead of suspending.
            void Object.assign(tracked, { status: "fulfilled", value: body });

            return body;
        },
        (error: unknown) => {
            // A failed chunk load must not be cached, or the post stays broken until reload.
            loadedBodies.delete(slug);

            throw error;
        },
    );

    loadedBodies.set(slug, tracked);

    return tracked;
};

/** How many posts the "Keep reading" grid shows. */
const KEEP_READING = 6;

/** A stable number for a slug. Plain arithmetic: the lint rules ban bitwise. */
const hashSeed = (value: string): number => {
    let seed = 7;

    for (const character of value) {
        seed = (seed * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
    }

    return seed;
};

/**
 * Fisher–Yates over a Lehmer generator.
 *
 * Not a good source of randomness and it does not need to be — it orders six
 * posts, reproducibly, from a seed the server and the browser both derive from
 * the slug. `Math.random()` would order them differently in the prerendered HTML
 * and on hydration, which is a mismatch React cannot patch up.
 */
const shuffle = <T,>(items: T[], seed: number): T[] => {
    const out = [...items];
    let state = seed === 0 ? 1 : seed;

    for (let index = out.length - 1; index > 0; index -= 1) {
        state = (state * 16_807) % 2_147_483_647;

        const swap = state % (index + 1);

        [out[index], out[swap]] = [out[swap], out[index]];
    }

    return out;
};

const WORD_SPLIT = /\s+/;

const toLink = (post?: { slug: string; title?: string }): PostLink | null => {
    if (!post) {
        return null;
    }

    return { slug: post.slug, title: post.title };
};

const buildPost = async (slug: string) => {
    const { getPost, listBlogPosts } = await import("@/lib/blog-source");
    const data = getPost(slug);

    if (!data) {
        return null;
    }

    const words = data.content.trim().split(WORD_SPLIT).filter(Boolean).length;
    const readingMinutes = Math.max(1, Math.round(words / 200));

    // `listBlogPosts()` is already normalised (ISO dates) and sorted newest-first.
    const all = listBlogPosts();
    const index = all.findIndex((other) => other.slug === slug);
    const newer = index > 0 ? all[index - 1] : undefined;
    const older = index >= 0 && index < all.length - 1 ? all[index + 1] : undefined;

    // "Keep reading" is this year's writing in a shuffled order, so two articles
    // do not recommend the same three posts — but the shuffle is seeded from the
    // slug rather than `Math.random()`. These pages are prerendered: a random
    // draw would bake one order into the HTML and then deal a different one on
    // hydration, which is a mismatch React cannot patch up.
    //
    // The year filter is applied only while it can be satisfied. In January, or
    // for a quiet year, an empty section is worse than an older post, so the
    // remainder tops up from the archive newest-first.
    const currentYear = String(new Date().getFullYear());
    const others = all.filter((other) => other.slug !== slug);
    const fromThisYear = others.filter((other) => other.publishedAt?.startsWith(currentYear));
    const rest = others.filter((other) => !other.publishedAt?.startsWith(currentYear));

    const related: RelatedPost[] = [...shuffle(fromThisYear, hashSeed(slug)), ...rest].slice(0, KEEP_READING).map((other) => {
        return {
            category: other.category,
            image: other.image,
            publishedAt: other.publishedAt,
            slug: other.slug,
            title: other.title,
        };
    });

    return {
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
    .middleware([staticFunctionMiddleware])
    .validator((slug: string) => slug)
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
    const { meta, next, prev, related, slug } = Route.useLoaderData();
    const { default: MdxContent, toc } = use(loadBody(slug));

    return (
        <BlogPost next={next} post={meta} prev={prev} related={related} slug={slug} toc={toc}>
            <MdxContent components={mdxComponents} />
        </BlogPost>
    );
};

export const Route = createFileRoute("/blog/$slug")({
    component: RouteComponent,
    // Posts are static for the life of a deployment, so don't re-run the loader on
    // client-side navigation.
    staleTime: Number.POSITIVE_INFINITY,
    loader: async ({ params }) => {
        // In the browser this reads the prerendered result for the slug; every post
        // is prerendered, so a missing one means the post does not exist.
        const [data] = await Promise.all([
            loadPost({ data: params.slug }).catch((error: unknown) => {
                if (import.meta.env.SSR) {
                    throw error;
                }

                return null;
            }),
            loadBody(params.slug),
        ]);

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

        // A post that ships real cover art should share it. The generated card is
        // the fallback for the posts that have none — which was every post until
        // now, because this ignored `meta.image` entirely.
        const cover = coverImageUrl(loaderData.meta.image) ?? `${SITE_URL}/api/og?${ogParameters.toString()}`;

        const seo = createSeoHead({
            description: loaderData.meta.description ?? `${loaderData.meta.title} — Lunora blog`,
            ogImage: cover,
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
