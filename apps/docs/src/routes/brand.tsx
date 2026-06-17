import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Brand from "@/pages/brand";

export const Route = createFileRoute("/brand")({
    component: () => <Brand />,
    head: () => {
        return {
            ...createSeoHead({
                description: "Lunora brand assets, logos, and usage guidelines for press and media.",
                path: "/brand",
                title: "Brand Assets",
            }),
        };
    },
});
