import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Nova from "@/pages/variants/v3";

export const Route = createFileRoute("/v3")({
    component: () => <Nova />,
    head: () =>
        createSeoHead({
            description: "Landing page variant 3 — Nova (code-forward bento).",
            path: "/v3",
            title: "Lunora — Variant 3",
        }),
});
