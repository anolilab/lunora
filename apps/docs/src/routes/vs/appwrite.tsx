import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import { ComparePage } from "@/pages/compare/compare-page";
import { COMPARISONS, othersFor } from "@/pages/compare/data";

const data = COMPARISONS.appwrite;

export const Route = createFileRoute("/vs/appwrite")({
    component: () => <ComparePage data={data} others={othersFor("appwrite")} />,
    head: () => {
        return { ...createSeoHead({ description: data.description, path: "/vs/appwrite", title: `Lunora vs ${data.name}` }) };
    },
});
