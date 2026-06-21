import SiX from "@icons-pack/react-simple-icons/icons/SiX.mjs";
import { Link } from "@tanstack/react-router";
import type { TOCItemType } from "fumadocs-core/toc";
import { DocsBody } from "fumadocs-ui/page";
import { ArrowLeft, Check, Link2 } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import JsonLd from "@/components/seo/json-ld";
import { SITE_URL } from "@/lib/seo";

import { Eyebrow, formatDate, initials } from "./shared";

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
            className="flex size-9 items-center justify-center border border-white/[0.08] text-white/55 transition-colors hover:border-white/20 hover:text-white"
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
            <p className="mb-1 font-mono text-[11px] tracking-wider text-white/40 uppercase">On this page</p>
            {items.map((item) => {
                const active = item.url.slice(1) === activeId;

                return (
                    <a
                        className={`transition-colors hover:text-white ${active ? "text-white" : "text-white/45"} ${item.depth >= 4 ? "pl-6" : ""} ${item.depth === 3 ? "pl-3" : ""}`}
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

// At the `lg` breakpoint the 3-col grid sits flush to the page guide lines; drop the
// card border on the side that meets a guide so it doesn't double the (translucent) line.
const edgeClass = (index: number): string => {
    const left = index % 3 === 0 ? "lg:border-l-0" : "";
    const right = index % 3 === 2 ? "lg:border-r-0" : "";

    return `${left} ${right}`.trim();
};

const RelatedCard: FC<{ edge?: string; post: RelatedPost }> = ({ edge = "", post }) => (
    <Link className={`group flex flex-col border border-white/[0.08] bg-white/[0.012] ${edge}`} params={{ slug: post.slug }} to="/blog/$slug">
        {post.image ? (
            <div className="relative aspect-1200/630 overflow-hidden bg-white/[0.03]">
                <img
                    alt={post.title ?? "Blog post"}
                    className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    decoding="async"
                    loading="lazy"
                    src={post.image}
                />
            </div>
        ) : null}
        <div className="flex flex-col gap-1.5 p-4">
            <Eyebrow>{post.category ?? "Blog"}</Eyebrow>
            <h3 className="text-sm font-semibold tracking-tight text-white transition-colors group-hover:text-white/70">{post.title}</h3>
            <time className="mt-1 font-mono text-[11px] tracking-wide text-white/40">{formatDate(post.publishedAt).formatted}</time>
        </div>
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
    const { formatted, iso } = formatDate(post.publishedAt);
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
        <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
            <JsonLd data={articleLd} />
            <JsonLd data={breadcrumbLd} />

            {/* atmospheric aurora glow behind the hero */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0,color-mix(in_oklab,var(--color-royal-amethyst)_18%,transparent),transparent)]"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
            />

            <section className="relative z-10" data-nav-theme="dark">
                <div className="mx-auto max-w-6xl px-5 pt-28 pb-24 lg:px-0">
                    <Link className="inline-flex items-center gap-1.5 text-sm text-white/50 transition-colors hover:text-white" to="/blog">
                        <ArrowLeft className="size-4" />
                        Blog
                    </Link>

                    {/* hero: title left, cover right */}
                    <div className="mt-8 grid items-center gap-8 lg:grid-cols-[1fr_minmax(0,440px)]">
                        <div>
                            <Eyebrow>{post.category ?? "Blog"}</Eyebrow>
                            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">{post.title}</h1>
                            {post.description ? <p className="mt-4 max-w-xl text-lg text-white/55">{post.description}</p> : null}
                        </div>
                        {post.image ? (
                            <div className="overflow-hidden border border-white/[0.08] bg-white/[0.03] lg:border-r-0">
                                <img alt={post.title ?? "Blog post"} className="aspect-1200/630 w-full object-cover" decoding="async" src={post.image} />
                            </div>
                        ) : null}
                    </div>

                    {/* byline + share */}
                    <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-y border-white/[0.08] py-4">
                        <div className="flex items-center gap-3 text-sm">
                            <span className="flex size-8 flex-none items-center justify-center rounded-full bg-royal-amethyst/15 text-[11px] font-semibold text-royal-amethyst">
                                {initials(post.author)}
                            </span>
                            {post.author ? <span className="font-medium text-white">{post.author}</span> : null}
                            {formatted ? (
                                <time className="font-mono text-xs tracking-wide text-white/40" dateTime={iso}>
                                    {formatted}
                                </time>
                            ) : null}
                            {post.readingMinutes ? (
                                <>
                                    <span aria-hidden="true" className="text-white/20">
                                        ·
                                    </span>
                                    <span className="font-mono text-xs tracking-wide text-white/40">{`${String(post.readingMinutes)} min read`}</span>
                                </>
                            ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                            <a
                                aria-label="Share on X"
                                className="flex size-9 items-center justify-center border border-white/[0.08] text-white/55 transition-colors hover:border-white/20 hover:text-white"
                                href={shareUrl}
                                rel="noreferrer"
                                target="_blank"
                            >
                                <SiX className="size-4 fill-current" title="Share on X" />
                            </a>
                            <CopyLinkButton url={url} />
                        </div>
                    </div>

                    {/* body: sticky TOC + prose */}
                    <div className="mt-12 grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)]">
                        {toc.length > 0 ? (
                            <aside className="hidden lg:block">
                                <div className="sticky top-24">
                                    <TableOfContents items={toc} />
                                </div>
                            </aside>
                        ) : (
                            <div className="hidden lg:block" />
                        )}
                        <DocsBody className="min-w-0 max-w-none [&_figure]:rounded-none! [&_figure_pre]:rounded-none! [&_pre]:rounded-none!">
                            {children}
                        </DocsBody>
                    </div>

                    {/* prev / next */}
                    {previous || next ? (
                        <nav aria-label="More posts" className="mt-16 grid gap-4 border-t border-white/[0.08] pt-8 sm:grid-cols-2">
                            {previous ? (
                                <Link
                                    className="group flex flex-col gap-1 border border-white/[0.08] p-5 transition-colors hover:border-white/20"
                                    params={{ slug: previous.slug }}
                                    to="/blog/$slug"
                                >
                                    <span className="font-mono text-[11px] tracking-wider text-white/40 uppercase">← Previous</span>
                                    <span className="font-medium text-white transition-colors group-hover:text-white/70">{previous.title}</span>
                                </Link>
                            ) : (
                                <div className="hidden sm:block" />
                            )}
                            {next ? (
                                <Link
                                    className="group flex flex-col items-end gap-1 border border-white/[0.08] p-5 text-right transition-colors hover:border-white/20"
                                    params={{ slug: next.slug }}
                                    to="/blog/$slug"
                                >
                                    <span className="font-mono text-[11px] tracking-wider text-white/40 uppercase">Next →</span>
                                    <span className="font-medium text-white transition-colors group-hover:text-white/70">{next.title}</span>
                                </Link>
                            ) : (
                                <div className="hidden sm:block" />
                            )}
                        </nav>
                    ) : null}

                    {/* related */}
                    {related.length > 0 ? (
                        <div className="mt-24 border-t border-white/[0.08] pt-12">
                            <h2 className="text-2xl font-semibold tracking-tight text-white">More from the blog</h2>
                            <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                                {related.map((item, index) => (
                                    <RelatedCard edge={edgeClass(index)} key={item.slug} post={item} />
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            </section>
        </div>
    );
};

export default BlogPost;
export type { BlogPostMeta, PostLink, RelatedPost };
