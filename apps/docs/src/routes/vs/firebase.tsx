import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import { ComparePage } from "@/pages/compare/compare-page";
import { COMPARISONS, othersFor } from "@/pages/compare/data";

const data = COMPARISONS.firebase;

export const Route = createFileRoute("/vs/firebase")({
    component: () => <ComparePage data={data} others={othersFor("firebase")} />,
    head: () => {
        return { ...createSeoHead({ description: data.description, path: "/vs/firebase", title: `Lunora vs ${data.name}` }) };
    },
});
