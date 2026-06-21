import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ArrowUpRight, Search } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import type { BlogPostSummary } from "@/lib/blog-source";

import { Eyebrow, formatDate, initials } from "./shared";

const POSTS_PER_PAGE = 10;

const Avatar: FC<{ name?: string }> = ({ name }) => (
    <span className="flex size-6 flex-none items-center justify-center rounded-full bg-royal-amethyst/15 text-[10px] font-semibold text-royal-amethyst">
        {initials(name)}
    </span>
);

const Chip: FC<{ children: string }> = ({ children }) => (
    <span className="border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] tracking-wider text-white/85 uppercase backdrop-blur">{children}</span>
);

const cardClass = "group flex flex-col border border-white/[0.08] bg-white/[0.012] transition-colors hover:border-white/20";

const FeaturedMain: FC<{ post: BlogPostSummary }> = ({ post }) => {
    const { formatted, iso } = formatDate(post.publishedAt);

    return (
        <Link className={`${cardClass} h-full lg:border-l-0`} params={{ slug: post.slug }} to="/blog/$slug">
            <div className="relative min-h-[300px] flex-1 overflow-hidden bg-white/[0.03]">
                {post.image ? (
                    <img
                        alt={post.title ?? "Blog post"}
                        className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
                        decoding="async"
                        src={post.image}
                    />
                ) : null}
                <span className="absolute top-4 left-4">
                    <Chip>{post.category ?? "Blog"}</Chip>
                </span>
            </div>
            <div className="p-5">
                <h2 className="text-2xl font-semibold tracking-tight text-balance text-white transition-colors group-hover:text-white/70">{post.title}</h2>
                {post.description ? <p className="mt-2 line-clamp-2 text-sm text-white/50">{post.description}</p> : null}
            </div>
            <div className="mt-auto flex items-center gap-2 border-t border-white/[0.08] px-5 py-4 text-xs text-white/45">
                <Avatar name={post.author} />
                {post.author ? <span className="text-white/70">{post.author}</span> : null}
                {formatted ? (
                    <time className="ml-auto font-mono tracking-wide text-white/40" dateTime={iso}>
                        {formatted}
                    </time>
                ) : null}
            </div>
        </Link>
    );
};

const FeaturedSide: FC<{ post: BlogPostSummary }> = ({ post }) => (
    <Link className={`${cardClass} flex-1 lg:border-r-0`} params={{ slug: post.slug }} to="/blog/$slug">
        <div className="relative aspect-1200/630 overflow-hidden bg-white/[0.03]">
            {post.image ? (
                <img
                    alt={post.title ?? "Blog post"}
                    className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    decoding="async"
                    loading="lazy"
                    src={post.image}
                />
            ) : null}
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-4">
            <Eyebrow>{post.category ?? "Blog"}</Eyebrow>
            <h3 className="text-sm font-semibold tracking-tight text-white transition-colors group-hover:text-white/70">{post.title}</h3>
            <time className="mt-auto pt-2 font-mono text-[11px] tracking-wide text-white/40">{formatDate(post.publishedAt).formatted}</time>
        </div>
    </Link>
);

const ArticleRow: FC<{ post: BlogPostSummary }> = ({ post }) => {
    const { formatted, iso } = formatDate(post.publishedAt);

    return (
        <li className="border-t border-white/[0.08] last:border-b">
            <Link
                className="group flex items-center gap-4 px-2 py-5 transition-colors hover:bg-white/[0.02] sm:gap-6"
                params={{ slug: post.slug }}
                to="/blog/$slug"
            >
                <div className="relative aspect-1200/630 w-28 flex-none overflow-hidden border border-white/[0.08] bg-white/[0.03] sm:w-40">
                    {post.image ? (
                        <img
                            alt={post.title ?? "Blog post"}
                            className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
                            decoding="async"
                            loading="lazy"
                            src={post.image}
                        />
                    ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Eyebrow>{post.category ?? "Blog"}</Eyebrow>
                    <h3 className="truncate text-base font-medium text-white transition-colors group-hover:text-white/70">{post.title}</h3>
                    <div className="flex items-center gap-2 text-xs text-white/45">
                        <Avatar name={post.author} />
                        {post.author ? <span>{post.author}</span> : null}
                    </div>
                </div>
                {formatted ? (
                    <time className="ml-auto hidden flex-none font-mono text-[11px] tracking-wide text-white/40 sm:block" dateTime={iso}>
                        {formatted}
                    </time>
                ) : null}
                <ArrowUpRight className="size-4 flex-none text-white/0 transition-colors group-hover:text-white/40" />
            </Link>
        </li>
    );
};

const pillClass = (active: boolean): string =>
    `border px-3 py-1 text-sm transition-colors ${active ? "border-white/20 bg-white/10 text-white" : "border-white/[0.08] text-white/55 hover:border-white/20 hover:text-white"}`;

const arrowClass =
    "flex size-9 items-center justify-center border border-white/[0.08] text-white/55 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40";

const Pagination: FC<{ current: number; onGoTo: (page: number) => void; total: number }> = ({ current, onGoTo, total }) => {
    if (total <= 1) {
        return null;
    }

    return (
        <nav aria-label="Pagination" className="mt-12 flex items-center justify-center gap-2">
            <button
                aria-label="Previous page"
                className={arrowClass}
                disabled={current <= 1}
                onClick={() => {
                    onGoTo(current - 1);
                }}
                type="button"
            >
                <ArrowLeft className="size-4" />
            </button>
            {Array.from({ length: total }, (_, index) => index + 1).map((number_) => (
                <button
                    aria-current={number_ === current ? "page" : undefined}
                    className={pillClass(number_ === current)}
                    key={number_}
                    onClick={() => {
                        onGoTo(number_);
                    }}
                    type="button"
                >
                    {number_}
                </button>
            ))}
            <button
                aria-label="Next page"
                className={arrowClass}
                disabled={current >= total}
                onClick={() => {
                    onGoTo(current + 1);
                }}
                type="button"
            >
                <ArrowRight className="size-4" />
            </button>
        </nav>
    );
};

const BlogOverview: FC<{ page?: number; posts: BlogPostSummary[] }> = ({ page = 1, posts }) => {
    const navigate = useNavigate();
    const [category, setCategory] = useState<string>("All");
    const [query, setQuery] = useState<string>("");

    const categories = useMemo(() => {
        const set = new Set<string>();

        for (const post of posts) {
            if (post.category) {
                set.add(post.category);
            }
        }

        return ["All", ...[...set].toSorted((a, b) => a.localeCompare(b))];
    }, [posts]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();

        return posts.filter((post) => {
            const matchesCategory = category === "All" || post.category === category;
            const matchesQuery =
                needle.length === 0 || (post.title ?? "").toLowerCase().includes(needle) || (post.description ?? "").toLowerCase().includes(needle);

            return matchesCategory && matchesQuery;
        });
    }, [posts, category, query]);

    // The three newest posts always headline the hero (an editorial highlight,
    // unaffected by the filters). "All articles" below is the full archive —
    // every post, narrowed by the category/search filter.
    const featured = posts.slice(0, 3);
    const [main, ...side] = featured;
    const listSource = filtered;

    const totalPages = Math.max(1, Math.ceil(listSource.length / POSTS_PER_PAGE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const start = (currentPage - 1) * POSTS_PER_PAGE;
    const visible = listSource.slice(start, start + POSTS_PER_PAGE);

    const goToPage = (next: number): void => {
        navigate({ search: next <= 1 ? {} : { page: next }, to: "/blog" }).catch(() => {});
    };

    const resetPage = (): void => {
        navigate({ search: {}, to: "/blog" }).catch(() => {});
    };

    const onCategory = (item: string): void => {
        setCategory(item);
        resetPage();
    };

    const onQuery = (value: string): void => {
        setQuery(value);
        resetPage();
    };

    return (
        <div className="relative overflow-x-clip bg-[#0e0e11]" data-theme="dark">
            {/* atmospheric aurora glow behind the header */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[420px] bg-[radial-gradient(55%_100%_at_50%_0,color-mix(in_oklab,var(--color-royal-amethyst)_16%,transparent),transparent)]"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-1/2 z-20 hidden w-full max-w-6xl -translate-x-1/2 border-x border-white/[0.08] lg:block"
            />

            <section className="relative z-10" data-nav-theme="dark">
                <div className={`mx-auto max-w-6xl px-5 pt-28 lg:px-0 ${posts.length === 0 ? "pb-24" : ""}`}>
                    <header className="mb-14">
                        <Eyebrow>Blog</Eyebrow>
                        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance text-white sm:text-5xl">News &amp; insights</h1>
                        <p className="mt-3 max-w-2xl text-lg text-white/55">Updates, deep dives, and engineering notes from the team building Lunora.</p>
                    </header>

                    {posts.length === 0 ? (
                        <div className="border border-white/[0.08] py-20 text-center">
                            <p className="text-lg font-semibold text-white">No posts yet</p>
                            <p className="mt-2 text-sm text-white/50">Check back soon for news and insights.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                            <div className="lg:col-span-2">
                                <FeaturedMain post={main} />
                            </div>
                            {side.length > 0 ? (
                                <div className="flex flex-col gap-6">
                                    {side.map((post) => (
                                        <FeaturedSide key={post.slug} post={post} />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>

                {posts.length > 0 ? (
                    <>
                        <div className="my-16 border-b">
                            <HatchSpacer />
                        </div>

                        <div className="mx-auto max-w-6xl px-5 pb-24 lg:px-0">
                            <h2 className="text-3xl font-semibold tracking-tight text-white">All articles</h2>

                            <div className="mt-6 flex flex-col gap-4 border-b border-white/[0.08] pb-4 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="mr-1 font-mono text-[11px] tracking-wider text-white/40 uppercase">Categories</span>
                                    {categories.map((item) => (
                                        <button
                                            className={pillClass(item === category)}
                                            key={item}
                                            onClick={() => {
                                                onCategory(item);
                                            }}
                                            type="button"
                                        >
                                            {item}
                                        </button>
                                    ))}
                                </div>

                                <div className="relative sm:w-64">
                                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/35" />
                                    <input
                                        aria-label="Search articles"
                                        className="w-full border border-white/[0.12] bg-white/[0.03] py-1.5 pr-3 pl-9 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
                                        onChange={(event) => {
                                            onQuery(event.target.value);
                                        }}
                                        placeholder="Search..."
                                        type="search"
                                        value={query}
                                    />
                                </div>
                            </div>

                            {visible.length === 0 ? (
                                <p className="py-16 text-center text-sm text-white/45">No articles match your filters.</p>
                            ) : (
                                <ul>
                                    {visible.map((post) => (
                                        <ArticleRow key={post.slug} post={post} />
                                    ))}
                                </ul>
                            )}

                            <Pagination current={currentPage} onGoTo={goToPage} total={totalPages} />
                        </div>
                    </>
                ) : null}
            </section>
        </div>
    );
};

export default BlogOverview;
