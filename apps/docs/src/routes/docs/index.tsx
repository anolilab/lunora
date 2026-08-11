import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import DocsHub from "@/pages/docs-hub";

/**
 * The `/docs` landing page.
 *
 * This is an index route, so it wins over the `/docs/$` splat for the exact
 * path — which means `src/content/docs/index.mdx` is no longer reachable at
 * `/docs`. That is intentional: the hub replaces it. Any content that page
 * carried belongs on `/docs/getting-started`.
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
