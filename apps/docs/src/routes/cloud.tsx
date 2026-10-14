import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import CloudLanding from "@/pages/cloud";

export const Route = createFileRoute("/cloud")({
    component: () => <CloudLanding />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Lunora Cloud is the managed way to run Lunora: managed Studio, observability, backups, and a human on support. Self-host on your own Cloudflare account, or run it on Lunora Cloud. Same code, no lock-in. Join the early-access waitlist.",
                path: "/cloud",
                title: "Lunora Cloud — early access",
            }),
        };
    },
});
