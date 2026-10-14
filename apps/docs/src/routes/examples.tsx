import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Examples from "@/pages/examples";

export const Route = createFileRoute("/examples")({
    component: () => <Examples />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Thirteen runnable Lunora example apps — real-time boards, chat, chess, SSR, auth, payments and offline sync — with source on GitHub and one-click Cloudflare deploys.",
                path: "/examples",
                title: "Examples",
            }),
        };
    },
});
