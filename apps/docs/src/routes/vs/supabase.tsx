import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import { ComparePage } from "@/pages/compare/compare-page";
import { COMPARISONS, othersFor } from "@/pages/compare/data";

const data = COMPARISONS.supabase;

export const Route = createFileRoute("/vs/supabase")({
    component: () => <ComparePage data={data} others={othersFor("supabase")} />,
    head: () => {
        return { ...createSeoHead({ description: data.description, path: "/vs/supabase", title: `Lunora vs ${data.name}` }) };
    },
});
