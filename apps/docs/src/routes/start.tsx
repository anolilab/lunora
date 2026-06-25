import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Start from "@/pages/start";

export const Route = createFileRoute("/start")({
    component: () => <Start />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Start a type-safe, real-time Lunora app on Cloudflare with your framework — TanStack Start (React or Solid), React Router, Nuxt, SvelteKit, Astro, Analog, or a standalone worker. One command scaffolds the backend wired in.",
                path: "/start",
                title: "Starter Kits",
            }),
        };
    },
});
