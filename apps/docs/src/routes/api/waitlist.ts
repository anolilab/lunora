import { createFileRoute } from "@tanstack/react-router";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Waitlist capture for Lunora Cloud (and the "notify at stable" list). Accepts
 * `{ email, source }` and validates the address.
 *
 * TODO: persist the signup. Right now it validates and acknowledges but does NOT
 * store anything — wire this to a real sink before relying on it (e.g. a
 * Cloudflare KV/D1 binding, Buttondown, or Resend Audiences). Tag rows by
 * `source` ("cloud" | "stable") so the two lists can be addressed separately.
 */
export const Route = createFileRoute("/api/waitlist")({
    server: {
        handlers: {
            POST: async ({ request }) => {
                const body = (await request.json().catch(() => null)) as { email?: unknown; source?: unknown } | null;
                const email = typeof body?.email === "string" ? body.email.trim() : "";
                const source = typeof body?.source === "string" ? body.source : "unknown";

                if (!EMAIL_RE.test(email)) {
                    return Response.json({ error: "invalid email", ok: false }, { status: 400 });
                }

                // eslint-disable-next-line no-console -- temporary until a real sink is wired (see TODO above)
                console.info("[waitlist] signup", { email, source });

                return Response.json({ ok: true });
            },
        },
    },
});
