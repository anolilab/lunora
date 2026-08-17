import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { createSeoHead, SITE_URL } from "@/lib/seo";
import BlogOverview from "@/pages/blog/overview";

const listPosts = createServerFn({ method: "GET" }).handler(async () => {
    const { listBlogPosts } = await import("@/lib/blog-source");

    return listBlogPosts();
});

const RouteComponent = () => <BlogOverview posts={Route.useLoaderData()} />;

// No `validateSearch`: the index used to paginate behind `?page=`, and the
// parsed value outlived the pagination by long enough to sit unused in the
// component's props. The archive reads in one scroll; a stale `?page=2` link
// now lands on the same complete list rather than on nothing.
export const Route = createFileRoute("/blog/")({
    component: RouteComponent,
    // The list is static per deployment; don't refetch on navigation back to /blog.
    staleTime: Number.POSITIVE_INFINITY,
    loader: () => listPosts(),
    head: () => {
        // The index had no card of its own, so every share of /blog showed the
        // generic site image with no hint of what the link was.
        const ogParameters = new URLSearchParams({
            description: "News, insights, and engineering deep dives from the team building Lunora.",
            eyebrow: "Blog",
            title: "News & insights",
        });

        const seo = createSeoHead({
            description: "News, insights, and engineering deep dives from the team building Lunora.",
            ogImage: `${SITE_URL}/api/og?${ogParameters.toString()}`,
            path: "/blog",
            title: "Blog",
        });

        return {
            ...seo,
            links: [...seo.links, { href: `${SITE_URL}/blog/rss.xml`, rel: "alternate", title: "Lunora Blog", type: "application/rss+xml" }],
        };
    },
});
