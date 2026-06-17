import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Folio from "@/pages/variants/v4";

export const Route = createFileRoute("/v4")({
    component: () => <Folio />,
    head: () =>
        createSeoHead({
            description: "Landing page variant 4 — Folio (editorial).",
            path: "/v4",
            title: "Lunora — Variant 4",
        }),
});
