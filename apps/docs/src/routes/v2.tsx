import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Prism from "@/pages/variants/v2";

export const Route = createFileRoute("/v2")({
    component: () => <Prism />,
    head: () =>
        createSeoHead({
            description: "Landing page variant 2 — Prism (gradient).",
            path: "/v2",
            title: "Lunora — Variant 2",
        }),
});
