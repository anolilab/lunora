import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import { ComparePage } from "@/pages/compare/compare-page";
import { COMPARISONS, othersFor } from "@/pages/compare/data";

const data = COMPARISONS.convex;

export const Route = createFileRoute("/vs/convex")({
    component: () => <ComparePage data={data} others={othersFor("convex")} />,
    head: () => {
        return { ...createSeoHead({ description: data.description, path: "/vs/convex", title: `Lunora vs ${data.name}` }) };
    },
});
