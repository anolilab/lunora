import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

/**
 * Deliberately loose: one `@`, a non-empty local part, and a domain with at
 * least one dot and no empty label. Delivery is the real test; this only rejects
 * input that is not an address. Split rather than a regex, which backtracks
 * super-linearly on long non-matching input.
 */
const isEmail = (value: string): boolean => {
    if (WHITESPACE.test(value)) {
        return false;
    }

    const parts = value.split("@");

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return false;
    }

    const labels = parts[1].split(".");

    return labels.length >= 2 && labels.every((label) => label.length > 0);
};

const WHITESPACE = /\s/u;
const MAX_EMAIL_LENGTH = 254;
const SOURCES = new Set(["cloud", "stable"]);

interface WaitlistBody {
    email?: unknown;
    honeyField?: unknown;
    privacy?: unknown;
    source?: unknown;
}

/**
 * `POST /api/waitlist` — stores one waitlist sign-up in the `WAITLIST` KV
 * namespace, keyed by the lowercased address so a repeat submission overwrites
 * rather than duplicates. Consent is recorded with the entry: GDPR requires an
 * explicit opt-in before an address is stored.
 */
export const Route = createFileRoute("/api/waitlist")({
    server: {
        handlers: {
            POST: async ({ request }) => {
                let body: WaitlistBody;

                try {
                    body = (await request.json()) as WaitlistBody;
                } catch {
                    return Response.json({ error: "invalid_body" }, { status: 400 });
                }

                // The honeypot field is hidden from people; any value means a bot filled it in.
                if (typeof body.honeyField === "string" && body.honeyField !== "") {
                    return Response.json({ ok: true }, { status: 200 });
                }

                const email = typeof body.email === "string" ? body.email.trim() : "";

                if (email.length > MAX_EMAIL_LENGTH || !isEmail(email)) {
                    return Response.json({ error: "invalid_email" }, { status: 400 });
                }

                if (body.privacy !== true) {
                    return Response.json({ error: "consent_required" }, { status: 400 });
                }

                const source = typeof body.source === "string" && SOURCES.has(body.source) ? body.source : "stable";
                const key = `waitlist:${email.toLowerCase()}`;

                await env.WAITLIST.put(key, JSON.stringify({ consent: true, source, submittedAt: new Date().toISOString() }));

                return Response.json({ ok: true }, { status: 200 });
            },
        },
    },
});
