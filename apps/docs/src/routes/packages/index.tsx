import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import PackagesListing from "@/pages/packages";

export const Route = createFileRoute("/packages/")({
    component: () => <PackagesListing />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Browse the Lunora package ecosystem — the server runtime, validators, client SDK, framework adapters, and opt-in add-ons for auth, mail, storage, scheduling, and more.",
                path: "/packages",
                title: "Packages",
            }),
        };
    },
});
