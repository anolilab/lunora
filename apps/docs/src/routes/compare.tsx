import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import CompareIndex from "@/pages/compare";

export const Route = createFileRoute("/compare")({
    component: () => <CompareIndex />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "How Lunora compares to Convex, Supabase, Firebase, and Appwrite. Lunora is a type-safe, real-time backend that runs on your own Cloudflare account at the edge — honest comparisons, including where each alternative still wins.",
                path: "/compare",
                title: "Lunora vs Convex, Supabase, Firebase, Appwrite",
            }),
        };
    },
});
