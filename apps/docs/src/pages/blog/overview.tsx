import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Search } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import HatchSpacer from "@/components/sections/hatch-spacer";
import { Kicker, Shell } from "@/kit/layout";
import { ArticleHeader } from "@/kit/page-header";
import type { BlogPostSummary } from "@/lib/blog-source";
import { cn } from "@/lib/utils";

import { Cover, formatDate, MetaLine } from "./shared";

/**
 * `/blog` — a magazine index. The three newest headline the page (one wide,
 * two beside it) and the whole archive follows as a filterable list. No card
 * chrome; the covers and the type carry it on the page's own canvas.
 */

const Byline: FC<{ name?: string }> = ({ name }) => (name === undefined ? null : <span className="text-[13px] text-ink-faint">{name}</span>);

const Featured: FC<{ post: BlogPostSummary }> = ({ post }) => (
    <Link className="group flex flex-col gap-6" params={{ slug: post.slug }} to="/blog/$slug">
        <Cover category={post.category} description={post.description} eager image={post.image} title={post.title} />
        <div className="flex flex-col gap-4">
            <MetaLine category={post.category} publishedAt={post.publishedAt} />
            <h2 className="max-w-2xl text-h2 font-bold text-balance text-ink transition-colors group-hover:text-ink-muted">{post.title}</h2>
            {post.description === undefined ? null : <p className="max-w-xl text-body text-ink-muted">{post.description}</p>}
            <Byline name={post.author} />
        </div>
    </Link>
);

/**
 * The two posts beside the lead. Their covers run the full width of the column
 * so the pair fills the lead's height — a thumbnail-sized cover left the band
 * two-thirds empty and made the sides read as an afterthought rather than as
 * the second and third stories.
 */
const FeaturedSide: FC<{ post: BlogPostSummary }> = ({ post }) => (
    <Link className="group flex flex-1 flex-col gap-4" params={{ slug: post.slug }} to="/blog/$slug">
        <Cover category={post.category} description={post.description} image={post.image} title={post.title} />
        <div className="flex flex-col gap-2.5">
            <MetaLine category={post.category} publishedAt={post.publishedAt} />
            <h3 className="text-h3 font-semibold text-balance text-ink transition-colors group-hover:text-ink-muted">{post.title}</h3>
            <Byline name={post.author} />
        </div>
    </Link>
);

/** One archive row: thumb, meta, title, author, date. */
const ArticleRow: FC<{ post: BlogPostSummary }> = ({ post }) => {
    const { formatted, iso } = formatDate(post.publishedAt);

    return (
        <li className="border-t border-hairline last:border-b">
            <Link className="group flex items-center gap-5 py-5 transition-colors hover:bg-wash sm:gap-7" params={{ slug: post.slug }} to="/blog/$slug">
                <div className="w-28 flex-none sm:w-40">
                    <Cover category={post.category} description={post.description} image={post.image} title={post.title} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <MetaLine category={post.category} publishedAt={post.publishedAt} />
                    <h3 className="truncate text-base font-medium text-ink transition-colors group-hover:text-ink-muted">{post.title}</h3>
                    <Byline name={post.author} />
                </div>
                {formatted ? (
                    <time className="ml-auto hidden flex-none font-mono text-xs text-ink-faint sm:block" dateTime={iso}>
                        {formatted}
                    </time>
                ) : null}
                <ArrowUpRight className="size-4 flex-none text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
        </li>
    );
};

const Filters: FC<{
    categories: string[];
    category: string;
    onCategory: (next: string) => void;
    onQuery: (next: string) => void;
    query: string;
}> = ({ categories, category, onCategory, onQuery, query }) => (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((name) => (
                <button
                    className={cn(
                        "border px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase transition-colors",
                        name === category ? "border-ink bg-ink text-canvas" : "border-hairline text-ink-faint hover:border-hairline-strong hover:text-ink",
                    )}
                    key={name}
                    onClick={() => {
                        onCategory(name);
                    }}
                    type="button"
                >
                    {name}
                </button>
            ))}
        </div>
        <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
            <input
                aria-label="Search articles"
                autoComplete="off"
                className="w-full border border-hairline bg-wash py-2 pr-4 pl-9 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-hairline-strong sm:w-64"
                data-1p-ignore=""
                data-form-type="other"
                data-lpignore="true"
                onChange={(event) => {
                    onQuery(event.target.value);
                }}
                placeholder="Search articles…"
                type="text"
                value={query}
            />
        </div>
    </div>
);

const BlogOverview: FC<{ posts: BlogPostSummary[] }> = ({ posts }) => {
    const [category, setCategory] = useState("All");
    const [query, setQuery] = useState("");

    const present = new Set(posts.flatMap((post) => (post.category === undefined ? [] : [post.category])));
    const categories = ["All", ...[...present].toSorted((a, b) => a.localeCompare(b))];

    // The three newest headline the page and are deliberately outside the filter:
    // they are an editorial highlight, not a query result, and a lead slot that
    // empties when you type reads as a broken page.
    const [lead, ...side] = posts.slice(0, 3);

    // "All articles" is the whole archive, not the leftovers — narrowing to a
    // category and not finding the post you just saw at the top would be worse
    // than showing it twice.
    const needle = query.trim().toLowerCase();
    const listed = posts.filter((post) => {
        if (category !== "All" && post.category !== category) {
            return false;
        }

        return needle.length === 0 || (post.title ?? "").toLowerCase().includes(needle) || (post.description ?? "").toLowerCase().includes(needle);
    });

    return (
        <div className="relative overflow-x-clip bg-canvas" data-theme="dark">
            <ArticleHeader
                breadcrumb={[{ label: "Lunora", to: "/" }, { label: "Blog" }]}
                lead="Updates, deep dives, and engineering notes from the team building Lunora."
                title="News & insights"
            />

            <section data-nav-theme="dark">
                <Shell className="flex items-center justify-between gap-4 border-b border-hairline py-4">
                    <Kicker size="micro">{String(posts.length)} Articles</Kicker>
                    <a className="font-mono text-micro text-ink-muted uppercase transition-colors hover:text-accent" href="/blog/rss.xml">
                        RSS
                    </a>
                </Shell>
            </section>

            {posts.length === 0 ? (
                <section data-nav-theme="dark">
                    <Shell className="py-24 text-center">
                        <p className="text-h3 font-semibold text-ink">No posts yet</p>
                        <p className="mt-2 text-body text-ink-muted">Check back soon for news and insights.</p>
                    </Shell>
                </section>
            ) : (
                <section data-nav-theme="dark">
                    <Shell className="grid grid-cols-1 gap-10 py-16 lg:grid-cols-[58fr_42fr] lg:gap-12">
                        <Featured post={lead} />
                        {side.length > 0 ? (
                            <div className="flex h-full flex-col gap-10">
                                {side.map((post) => (
                                    <FeaturedSide key={post.slug} post={post} />
                                ))}
                            </div>
                        ) : null}
                    </Shell>

                    <HatchSpacer />

                    <Shell className="py-16">
                        <div className="mb-8 flex flex-col gap-6">
                            <h2 className="text-h2 font-semibold tracking-tight text-ink">All articles</h2>
                            <Filters categories={categories} category={category} onCategory={setCategory} onQuery={setQuery} query={query} />
                        </div>

                        {listed.length > 0 ? (
                            <ul>
                                {listed.map((post) => (
                                    <ArticleRow key={post.slug} post={post} />
                                ))}
                            </ul>
                        ) : (
                            <div className="flex flex-col items-center gap-4 border-t border-hairline py-20">
                                <p className="text-body text-ink-faint">No articles match that filter.</p>
                                <button
                                    className="text-sm text-ink-muted underline underline-offset-4 transition-colors hover:text-ink"
                                    onClick={() => {
                                        setCategory("All");
                                        setQuery("");
                                    }}
                                    type="button"
                                >
                                    Clear filters
                                </button>
                            </div>
                        )}
                    </Shell>
                </section>
            )}
        </div>
    );
};

export default BlogOverview;
