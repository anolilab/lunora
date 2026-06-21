import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { createSeoHead, SITE_URL } from "@/lib/seo";
import BlogOverview from "@/pages/blog/overview";

const listPosts = createServerFn({ method: "GET" }).handler(async () => {
    const { listBlogPosts } = await import("@/lib/blog-source");

    return listBlogPosts();
});

const RouteComponent = () => {
    const posts = Route.useLoaderData();
    const { page } = Route.useSearch();

    return <BlogOverview page={page ?? 1} posts={posts} />;
};

// eslint-disable-next-line import/prefer-default-export -- TanStack Start file-based routing requires `export const Route`
export const Route = createFileRoute("/blog/")({
    component: RouteComponent,
    validateSearch: (search: Record<string, unknown>): { page?: number } => {
        const page = Number(search.page);

        return Number.isInteger(page) && page > 0 ? { page } : {};
    },
    loader: () => listPosts(),
    head: () => {
        const seo = createSeoHead({
            description: "News, insights, and engineering deep dives from the team building Lunora.",
            path: "/blog",
            title: "Blog",
        });

        return {
            ...seo,
            links: [...seo.links, { href: `${SITE_URL}/blog/rss.xml`, rel: "alternate", title: "Lunora Blog", type: "application/rss+xml" }],
        };
    },
});
