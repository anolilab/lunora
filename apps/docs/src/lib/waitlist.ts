import type { KVNamespace, RateLimit } from "@cloudflare/workers-types/index.ts";

import { ipRateLimitKey } from "../../../../shared/ip-rate-limit-key";
import { verifyTurnstile } from "./turnstile";
import { readWaitlistBody } from "./waitlist-body";

interface WaitlistDependencies {
    fetcher?: typeof fetch;
    limiter: Pick<RateLimit, "limit">;
    store: Pick<KVNamespace, "put">;
    turnstileSecret: string;
    /** Resolves after `ms`; injected so tests need not wait out the KV cooldown. */
    wait?: (ms: number) => Promise<void>;
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

/** KV accepts one write per key per second and answers a faster one with this error. */
const SAME_KEY_THROTTLED = /\b429\b/u;

const isJsonRequest = (request: Request): boolean => request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";

/**
 * Refuses a request before its body is read. A `text/plain` or form-encoded POST from
 * another site skips the CORS preflight, so only a same-origin JSON request passes.
 */
const refuseRequest = (request: Request): Response | undefined => {
    if (!isJsonRequest(request)) {
        return Response.json({ error: "unsupported_media_type" }, { status: 415 });
    }

    if (request.headers.get("origin") !== new URL(request.url).origin) {
        return Response.json({ error: "cross_origin" }, { status: 403 });
    }

    return undefined;
};

/**
 * Counts one verified sign-up against the client's address, so a client that solves
 * Turnstile cannot sign up address after address. It runs after verification, so
 * requests that fail validation or Turnstile never use up the allowance of other
 * people behind the same address. Without a client address every caller would share
 * one bucket, so the limit is skipped rather than applied to all. An IPv6 client
 * counts against its /64, which it usually holds whole. When the limiter itself fails,
 * the sign-up is refused rather than stored unchecked.
 */
const checkLimit = async (clientIp: string | null, limiter: WaitlistDependencies["limiter"]): Promise<"allowed" | "limited" | "unavailable"> => {
    if (!clientIp) {
        return "allowed";
    }

    try {
        const { success } = await limiter.limit({ key: ipRateLimitKey(clientIp) });

        return success ? "allowed" : "limited";
    } catch (error) {
        // The error is logged without the key, which holds the client address.
        // eslint-disable-next-line no-console -- Workers Logs is the only record of a failed limit check
        console.error("waitlist: rate limit check failed", error);

        return "unavailable";
    }
};

/** KV's per-key write cooldown; a write after it is no longer throttled by the one before. */
const SAME_KEY_COOLDOWN_MS = 1000;

const delay = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const isSameKeyThrottle = (error: unknown): boolean => error instanceof Error && SAME_KEY_THROTTLED.test(error.message);

/**
 * Whether the sign-up is in KV once this returns. A same-key throttle means another
 * write for this address landed within the last second, but KV reads are eventually
 * consistent, so a read cannot confirm it; the write is retried once after the cooldown.
 */
const storeSignUp = async ({ store, wait = delay }: Pick<WaitlistDependencies, "store" | "wait">, email: string, source: string): Promise<boolean> => {
    const key = `waitlist:${email.toLowerCase()}`;
    const value = JSON.stringify({ consent: true, source, submittedAt: new Date().toISOString() });

    try {
        try {
            await store.put(key, value);
        } catch (error) {
            if (!isSameKeyThrottle(error)) {
                throw error;
            }

            await wait(SAME_KEY_COOLDOWN_MS);
            await store.put(key, value);
        }

        return true;
    } catch (error) {
        // The error is logged without the key, which holds the submitted address.
        // eslint-disable-next-line no-console -- Workers Logs is the only record of a failed write
        console.error("waitlist: KV write failed", error);

        return false;
    }
};

/**
 * Stores one waitlist sign-up, keyed by the lowercased address so a repeat
 * submission overwrites rather than duplicates. Consent is recorded with the
 * entry: GDPR requires an explicit opt-in before an address is stored. The
 * Turnstile check runs after validation, so malformed input never costs a `siteverify` call.
 */
const handleWaitlist = async (request: Request, { fetcher, limiter, store, turnstileSecret, wait }: WaitlistDependencies): Promise<Response> => {
    const refused = refuseRequest(request);

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

    const clientIp = request.headers.get("CF-Connecting-IP");

    if (!(await verifyTurnstile(body.turnstileToken, turnstileSecret, clientIp, fetcher))) {
        return Response.json({ error: "verification_failed" }, { status: 403 });
    }

    const limit = await checkLimit(clientIp, limiter);

    if (limit === "limited") {
        return Response.json({ error: "rate_limited" }, { status: 429 });
    }

    if (limit === "unavailable") {
        return Response.json({ error: "rate_limit_unavailable" }, { status: 503 });
    }

    if (!(await storeSignUp({ store, wait }, email, typeof body.source === "string" && SOURCES.has(body.source) ? body.source : "stable"))) {
        return Response.json({ error: "store_unavailable" }, { status: 503 });
    }

    return Response.json({ ok: true }, { status: 200 });
};

export type { WaitlistDependencies };
export { handleWaitlist };
