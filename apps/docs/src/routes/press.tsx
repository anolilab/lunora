import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Press from "@/pages/press";

export const Route = createFileRoute("/press")({
    component: () => <Press />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Download Lunora's logo, wordmark, and color palette, and grab boilerplate copy for writing about the type-safe real-time edge backend framework.",
                path: "/press",
                title: "Press & Brand",
            }),
        };
    },
});
