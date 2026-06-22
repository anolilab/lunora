import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import ConvexCompare from "@/pages/vs-convex";

export const Route = createFileRoute("/vs/convex")({
    component: () => <ConvexCompare />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Lunora vs Convex: the same Convex-style developer experience (typed queries, reactive subscriptions, end-to-end types), but it runs on your own Cloudflare account or on Lunora Cloud. An honest comparison, including where Convex still wins.",
                path: "/vs/convex",
                title: "Lunora vs Convex",
            }),
        };
    },
});
