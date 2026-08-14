import SiX from "@icons-pack/react-simple-icons/icons/SiX.mjs";
import { Link } from "@tanstack/react-router";
import type { TOCItemType } from "fumadocs-core/toc";
import { DocsBody } from "fumadocs-ui/page";
import { Check, Link2 } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import JsonLd from "@/components/seo/json-ld";
import { Kicker, Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import { isFallbackImage, SITE_URL } from "@/lib/seo";

import { Cover, formatDate, MetaLine } from "./shared";

/**
 * `/blog/$slug` — one post, set as the same publication as the index: the
 * shared `ArticleHeader` carries the trail, the title and the date, and the
 * page below it is the article column with a sticky contents rail beside it.
 * No card chrome; hairlines and the type do the separating.
 */

interface BlogPostMeta {
    author?: string;
    category?: string;
    description?: string;
    image?: string;
    publishedAt?: string;
    readingMinutes?: number;
    title?: string;
}

interface RelatedPost {
    category?: string;
    image?: string;
    publishedAt?: string;
    slug: string;
    title?: string;
}

interface PostLink {
    slug: string;
    title?: string;
}

const EMPTY_RELATED: RelatedPost[] = [];
const EMPTY_TOC: TOCItemType[] = [];

const CopyLinkButton: FC<{ url: string }> = ({ url }) => {
    const [copied, setCopied] = useState(false);

    const onCopy = (): void => {
        setCopied(true);
        navigator.clipboard.writeText(url).catch(() => {});
        globalThis.setTimeout(setCopied, 1500, false);
    };

    return (
        <button
            aria-label="Copy link"
            className="flex size-9 items-center justify-center border border-hairline text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
            onClick={onCopy}
            type="button"
        >
            {copied ? <Check className="size-4 text-emerald-400" /> : <Link2 className="size-4" />}
        </button>
    );
};

// Scrollspy: highlight the heading currently in view as you scroll the article.
const TableOfContents: FC<{ items: TOCItemType[] }> = ({ items }) => {
    const [activeId, setActiveId] = useState("");
    const ids = useMemo(() => items.map((item) => item.url.slice(1)), [items]);

    useEffect(() => {
        const elements = ids.map((id) => document.querySelector<HTMLElement>(`[id="${id}"]`)).filter((element): element is HTMLElement => element !== null);

        if (elements.length === 0) {
            return undefined;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                const visible = entries.filter((entry) => entry.isIntersecting).toSorted((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

                if (visible[0]) {
                    setActiveId(visible[0].target.id);
                }
            },
            { rootMargin: "-80px 0px -70% 0px" },
        );

        elements.forEach((element) => {
            observer.observe(element);
        });

        return () => {
            observer.disconnect();
        };
    }, [ids]);

    return (
        <nav aria-label="Table of contents" className="flex flex-col gap-2 text-sm">
            <Kicker className="mb-1" size="micro">
                On this page
            </Kicker>
            {items.map((item) => {
                const active = item.url.slice(1) === activeId;

                return (
                    <a
                        className={`transition-colors hover:text-ink ${active ? "text-ink" : "text-ink-faint"} ${item.depth >= 4 ? "pl-6" : ""} ${item.depth === 3 ? "pl-3" : ""}`}
                        href={item.url}
                        key={item.url}
                    >
                        {item.title}
                    </a>
                );
            })}
        </nav>
    );
};

/** `CATEGORY · DATE`, the index's meta line, reused for the related tiles. */
const RelatedCard: FC<{ post: RelatedPost }> = ({ post }) => (
    <Link className="group flex flex-col gap-4" params={{ slug: post.slug }} to="/blog/$slug">
        <Cover category={post.category} image={post.image} title={post.title} />
        <div className="flex flex-col gap-2.5">
            <MetaLine category={post.category} publishedAt={post.publishedAt} />
            <h3 className="text-base font-medium text-balance text-ink transition-colors group-hover:text-ink-muted">{post.title}</h3>
        </div>
    </Link>
);

/** Author and reading time — the two facts the header does not already carry. */
const Byline: FC<{ author?: string; readingMinutes?: number }> = ({ author, readingMinutes }) => {
    const parts = [author, readingMinutes ? `${String(readingMinutes)} min read` : undefined].filter((part): part is string => part !== undefined);

    if (parts.length === 0) {
        return null;
    }

    return (
        <Kicker className="flex items-center gap-2" size="micro">
            {parts.map((part, index) => (
                <span className="flex items-center gap-2" key={part}>
                    {index > 0 ? <span aria-hidden="true">·</span> : null}
                    {part}
                </span>
            ))}
        </Kicker>
    );
};

const PostNavLink: FC<{ direction: "next" | "previous"; post: PostLink }> = ({ direction, post }) => (
    <Link
        className={`group flex flex-col gap-1.5 border-t border-hairline py-5 transition-colors hover:border-hairline-strong ${direction === "next" ? "sm:items-end sm:text-right" : ""}`}
        params={{ slug: post.slug }}
        to="/blog/$slug"
    >
        <Kicker size="micro">{direction === "next" ? "Next →" : "← Previous"}</Kicker>
        <span className="font-medium text-ink transition-colors group-hover:text-ink-muted">{post.title}</span>
    </Link>
);

const BlogPost: FC<{
    children: ReactNode;
    next?: PostLink | null;
    post: BlogPostMeta;
    prev?: PostLink | null;
    related?: RelatedPost[];
    slug: string;
    toc?: TOCItemType[];
}> = ({ children, next = null, post, prev: previous = null, related = EMPTY_RELATED, slug, toc = EMPTY_TOC }) => {
    const { formatted } = formatDate(post.publishedAt);
    const cover = isFallbackImage(post.image) ? undefined : post.image;
    const url = `${SITE_URL}/blog/${slug}`;
    const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(post.title ?? "")}&url=${encodeURIComponent(url)}`;

    const articleLd = {
        "@type": "BlogPosting",
        author: { "@type": "Person", name: post.author ?? "Lunora" },
        dateModified: post.publishedAt,
        datePublished: post.publishedAt,
        description: post.description,
        headline: post.title,
        image: post.image ? `${SITE_URL}${post.image}` : undefined,
        mainEntityOfPage: url,
        publisher: { "@type": "Organization", logo: { "@type": "ImageObject", url: `${SITE_URL}/favicon.svg` }, name: "Lunora" },
        url,
    };

    const breadcrumbLd = {
        "@type": "BreadcrumbList",
        itemListElement: [
            { "@type": "ListItem", item: SITE_URL, name: "Home", position: 1 },
            { "@type": "ListItem", item: `${SITE_URL}/blog`, name: "Blog", position: 2 },
            { "@type": "ListItem", item: url, name: post.title, position: 3 },
        ],
    };

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <JsonLd data={articleLd} />
            <JsonLd data={breadcrumbLd} />

            <ArticleHeader
                breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Blog", to: "/blog" }, { label: post.category ?? "Post" }]}
                lead={post.description}
                meta={formatted || undefined}
                title={post.title}
            />

            <section data-nav-theme="dark">
                {/* Running text keeps its own measure inside the shell; the
                    contents rail takes the column beside it so the prose stays
                    flush with the header's left edge. */}
                <Shell className="grid grid-cols-1 gap-10 py-16 lg:grid-cols-[minmax(0,1fr)_200px] lg:gap-12">
                    <article className="min-w-0 max-w-3xl">
                        {cover ? (
                            <img
                                alt={`Cover for ${post.title ?? "this post"}`}
                                className="mb-10 aspect-1200/630 w-full bg-wash object-cover"
                                decoding="async"
                                src={cover}
                            />
                        ) : null}

                        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-5">
                            <Byline author={post.author} readingMinutes={post.readingMinutes} />
                            <div className="flex items-center gap-2">
                                <a
                                    aria-label="Share on X"
                                    className="flex size-9 items-center justify-center border border-hairline text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                                    href={shareUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                >
                                    <SiX className="size-4 fill-current" title="Share on X" />
                                </a>
                                <CopyLinkButton url={url} />
                            </div>
                        </div>

                        <DocsBody className="mt-10 min-w-0 max-w-none [&_figure]:rounded-none! [&_figure_pre]:rounded-none! [&_pre]:rounded-none!">
                            {children}
                        </DocsBody>

                        {previous || next ? (
                            <nav aria-label="More posts" className="mt-16 grid gap-x-10 sm:grid-cols-2">
                                {previous ? <PostNavLink direction="previous" post={previous} /> : <div className="hidden sm:block" />}
                                {next ? <PostNavLink direction="next" post={next} /> : <div className="hidden sm:block" />}
                            </nav>
                        ) : null}
                    </article>

                    {toc.length > 0 ? (
                        <aside className="hidden lg:block">
                            <div className="sticky top-[var(--site-nav-height)]">
                                <TableOfContents items={toc} />
                            </div>
                        </aside>
                    ) : null}
                </Shell>
            </section>

            {related.length > 0 ? (
                <>
                    <HatchSpacer />
                    <section data-nav-theme="dark">
                        <Shell className="grid gap-10 py-16 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:gap-16">
                            <div className="lg:sticky lg:top-32 lg:self-start">
                                <Kicker size="micro">Blog</Kicker>
                                <h2 className="mt-3 text-h2 font-semibold tracking-tight text-ink">Keep reading</h2>
                            </div>
                            <div className="grid grid-cols-1 gap-x-10 gap-y-14 sm:grid-cols-2">
                                {related.map((item) => (
                                    <RelatedCard key={item.slug} post={item} />
                                ))}
                            </div>
                        </Shell>
                    </section>
                </>
            ) : null}
        </div>
    );
};

export default BlogPost;
export type { BlogPostMeta, PostLink, RelatedPost };
