import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { handleWaitlist } from "@/lib/waitlist";

/** `POST /api/waitlist` — see `handleWaitlist` for what is checked and stored. */
export const Route = createFileRoute("/api/waitlist")({
    server: {
        handlers: {
            POST: ({ request }) => handleWaitlist(request, { store: env.WAITLIST, turnstileSecret: env.TURNSTILE_SECRET_KEY }),
        },
    },
});
