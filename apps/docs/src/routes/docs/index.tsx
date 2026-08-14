import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import DocsHub from "@/pages/docs-hub";

/**
 * The `/docs` landing page.
 *
 * This is an index route, so it wins over the `/docs/$` splat for the exact
 * path. The prose that used to live at `/docs` now lives at `/docs/overview`
 * (`src/content/docs/overview.mdx`) — an index-named MDX file would still be
 * indexed by Fumadocs, still appear in the sidebar and in `/llms.txt`, and
 * still resolve to `/docs`, where this hub is served instead. Renaming it keeps
 * the page readable rather than shadowed.
 */
export const Route = createFileRoute("/docs/")({
    component: () => <DocsHub />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Documentation for Lunora — the type-safe realtime backend for Cloudflare Workers and Durable Objects. Framework guides for React, Vue, Svelte, and Solid, plus the CLI, Studio, and add-on packages.",
                path: "/docs",
                title: "Documentation",
            }),
        };
    },
});
