import type { KVNamespace, RateLimit } from "@cloudflare/workers-types/index.ts";

import { verifyTurnstile } from "./turnstile";
import { readWaitlistBody } from "./waitlist-body";

interface WaitlistDependencies {
    fetcher?: typeof fetch;
    limiter: Pick<RateLimit, "limit">;
    store: Pick<KVNamespace, "put">;
    turnstileSecret: string;
}

const WHITESPACE = /\s/u;
const MAX_EMAIL_LENGTH = 254;
const SOURCES = new Set(["cloud", "stable"]);

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

/**
 * KV accepts one write per key per second and answers a faster one with this error. It
 * is the only failure that means the address was just stored, so it alone counts as success.
 */
const SAME_KEY_THROTTLED = /\b429\b/u;

const isJsonRequest = (request: Request): boolean => request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";

/**
 * Refuses a request before its body is read. A `text/plain` or form-encoded POST from
 * another site skips the CORS preflight, so only a same-origin JSON request passes. The
 * per-address limit keeps one client that solves Turnstile from signing up address after
 * address.
 */
const refuseRequest = async (request: Request, clientIp: string | null, limiter: WaitlistDependencies["limiter"]): Promise<Response | undefined> => {
    if (!isJsonRequest(request)) {
        return Response.json({ error: "unsupported_media_type" }, { status: 415 });
    }

    if (request.headers.get("origin") !== new URL(request.url).origin) {
        return Response.json({ error: "cross_origin" }, { status: 403 });
    }

    // Without a client address every caller would share one bucket, so the limit is skipped rather than applied to all.
    if (clientIp) {
        const { success } = await limiter.limit({ key: clientIp });

        if (!success) {
            return Response.json({ error: "rate_limited" }, { status: 429 });
        }
    }

    return undefined;
};

const storeSignUp = async (store: WaitlistDependencies["store"], email: string, source: string): Promise<Response> => {
    try {
        await store.put(`waitlist:${email.toLowerCase()}`, JSON.stringify({ consent: true, source, submittedAt: new Date().toISOString() }));
    } catch (error) {
        if (!(error instanceof Error && SAME_KEY_THROTTLED.test(error.message))) {
            return Response.json({ error: "store_unavailable" }, { status: 503 });
        }
    }

    return Response.json({ ok: true }, { status: 200 });
};

/**
 * Stores one waitlist sign-up, keyed by the lowercased address so a repeat
 * submission overwrites rather than duplicates. Consent is recorded with the
 * entry: GDPR requires an explicit opt-in before an address is stored. The
 * Turnstile check runs last, so malformed input never costs a `siteverify` call.
 */
const handleWaitlist = async (request: Request, { fetcher, limiter, store, turnstileSecret }: WaitlistDependencies): Promise<Response> => {
    const clientIp = request.headers.get("CF-Connecting-IP");
    const refused = await refuseRequest(request, clientIp, limiter);

    if (refused) {
        return refused;
    }

    const body = await readWaitlistBody(request);

    if (body === "too_large") {
        return Response.json({ error: "body_too_large" }, { status: 413 });
    }

    if (body === undefined) {
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

    if (!(await verifyTurnstile(body.turnstileToken, turnstileSecret, clientIp, fetcher))) {
        return Response.json({ error: "verification_failed" }, { status: 403 });
    }

    return storeSignUp(store, email, typeof body.source === "string" && SOURCES.has(body.source) ? body.source : "stable");
};

export type { WaitlistDependencies };
export { handleWaitlist };
