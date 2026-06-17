import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Lumen from "@/pages/variants/v1";

export const Route = createFileRoute("/v1")({
    component: () => <Lumen />,
    head: () =>
        createSeoHead({
            description: "Landing page variant 1 — Lumen (minimal).",
            path: "/v1",
            title: "Lunora — Variant 1",
        }),
});
