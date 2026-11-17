import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Sponsors from "@/pages/sponsors";

export const Route = createFileRoute("/sponsors")({
    component: () => <Sponsors />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Sponsor Lunora, the free, open-source realtime backend for Cloudflare Workers and Durable Objects. See what sponsorship funds, the tiers, and how to start.",
                path: "/sponsors",
                title: "Sponsors",
            }),
        };
    },
});
