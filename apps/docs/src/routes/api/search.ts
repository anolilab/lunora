import { createFileRoute } from "@tanstack/react-router";

import { searchServer } from "@/lib/search-server";

export const Route = createFileRoute("/api/search")({
    server: {
        handlers: {
            GET: async ({ request }) => searchServer.GET(request),
        },
    },
});
