import { createFileRoute } from "@tanstack/react-router";

import { createSeoHead } from "@/lib/seo";
import Home from "@/pages/home";

export const Route = createFileRoute("/")({
    component: () => <Home />,
    head: () => {
        return {
            ...createSeoHead({
                description:
                    "Lunora gives you typed queries, mutations, and live subscriptions that sync from your Cloudflare Workers + Durable Objects backend straight to the client — with a Vite-first developer experience.",
                path: "/",
                title: "The realtime backend for Cloudflare Workers",
            }),
        };
    },
});
