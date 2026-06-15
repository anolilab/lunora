/**
 * Cloudflare Turnstile server-side verification.
 *
 * Turnstile has **no Cloudflare binding** — verification is a single HTTPS POST
 * to the public `siteverify` endpoint with your secret key. The secret lives in
 * a plain env var / `.dev.vars` (conventionally `TURNSTILE_SECRET_KEY`), not in
 * `wrangler.jsonc`. This module is therefore pure, transport-agnostic, and
 * usable from any mutation/action — not just the auth flow.
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

/** Cloudflare's public Turnstile `siteverify` endpoint. */
const TURNSTILE_VERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Minimal `fetch` shape we depend on, so callers can inject a stub in tests. */
type FetchLike = (input: string, init?: { body?: BodyInit; headers?: Record<string, string>; method?: string }) => Promise<Response>;

interface VerifyTurnstileOptions {
    /**
     * Inject a `fetch` implementation. Defaults to `globalThis.fetch`. Primarily
     * for unit tests — production callers can omit it.
     */
    fetch?: FetchLike;

    /**
     * The visitor's IP address, if known. Optional; Cloudflare uses it as an
     * extra signal but verification works without it.
     */
    remoteip?: string;
    /** Your Turnstile secret key (the `TURNSTILE_SECRET_KEY` env var). */
    secret: string;
    /** The `cf-turnstile-response` token produced by the widget on the client. */
    token: string;
}

/**
 * The normalized result of a Turnstile verification. Snake-cased fields from
 * Cloudflare (`error-codes`, `challenge_ts`) are mapped to camelCase.
 *
 * A `success: false` verdict is a **bot/invalid-token** outcome, not an error —
 * it is returned, never thrown. `verifyTurnstile` only throws on transport
 * failure (network error, non-2xx response).
 */
interface TurnstileVerifyResult {
    /** The customer-supplied `action` the widget was rendered with, if any. */
    action?: string;
    /** Customer data passed through the widget (`cData`), if any. */
    cdata?: string;
    /** ISO timestamp of the challenge, if Cloudflare returned one. */
    challengeTs?: string;

    /**
     * Cloudflare error codes for a failed verification (e.g.
     * `"invalid-input-response"`, `"timeout-or-duplicate"`). Empty on success.
     */
    errorCodes: string[];
    /** Hostname the challenge was solved on, if Cloudflare returned one. */
    hostname?: string;
    /** Whether Cloudflare considers the token valid. */
    success: boolean;
}

/** Raw JSON shape returned by the siteverify endpoint. */
interface RawSiteverifyResponse {
    action?: unknown;
    cdata?: unknown;
    challenge_ts?: unknown;
    "error-codes"?: unknown;
    hostname?: unknown;
    success?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/**
 * Verify a Turnstile token against Cloudflare's `siteverify` endpoint.
 *
 * POSTs `application/x-www-form-urlencoded` (`secret`, `response`=token, and an
 * optional `remoteip`) and returns the parsed verdict. A `success: false`
 * outcome (bot / invalid / expired token) is **returned**, not thrown — callers
 * decide how to react. The function throws a structural `CirrusError`-shaped
 * error (`{ name: "CirrusError", code: "SERVICE_UNAVAILABLE", status: 503 }`)
 * only when the siteverify call itself fails (network error or non-2xx), so a
 * "siteverify is down" failure is distinguishable from a "this is a bot"
 * verdict.
 */
const verifyTurnstile = async ({ fetch = globalThis.fetch, remoteip, secret, token }: VerifyTurnstileOptions): Promise<TurnstileVerifyResult> => {
    const body = new URLSearchParams({ response: token, secret });

    if (remoteip !== undefined && remoteip !== "") {
        body.set("remoteip", remoteip);
    }

    let response: Response;

    try {
        response = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
            body: body.toString(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
        });
    } catch (error) {
        throw Object.assign(new Error("turnstile siteverify request failed"), {
            cause: error,
            code: "SERVICE_UNAVAILABLE",
            name: "CirrusError",
            status: 503,
        });
    }

    if (!response.ok) {
        throw Object.assign(new Error(`turnstile siteverify returned ${String(response.status)}`), {
            code: "SERVICE_UNAVAILABLE",
            name: "CirrusError",
            status: 503,
        });
    }

    const raw: RawSiteverifyResponse = await response.json();

    return {
        action: asString(raw.action),
        cdata: asString(raw.cdata),
        challengeTs: asString(raw.challenge_ts),
        errorCodes: asStringArray(raw["error-codes"]),
        hostname: asString(raw.hostname),
        success: raw.success === true,
    };
};

export { TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile };
export type { FetchLike, TurnstileVerifyResult, VerifyTurnstileOptions };
