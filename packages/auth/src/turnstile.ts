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

import { LunoraError } from "@lunora/errors";

/** Cloudflare's public Turnstile `siteverify` endpoint. */
const TURNSTILE_VERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Minimal `fetch` shape we depend on, so callers can inject a stub in tests. */
type FetchLike = (input: string, init?: { body?: BodyInit; headers?: Record<string, string>; method?: string }) => Promise<Response>;

interface VerifyTurnstileOptions {
    /**
     * Assert the widget `action` the token was solved for. Cloudflare echoes the
     * customer-supplied `action` back in the siteverify response; when this is
     * set and the returned `action` does not match, the verdict is downgraded to
     * `success: false` (with error code `action-mismatch`). Leave unset to skip
     * the check.
     */
    expectedAction?: string;

    /**
     * Assert the `hostname` the challenge was solved on. Cloudflare returns the
     * solving hostname in the siteverify response; when this is set and the
     * returned `hostname` does not match, the verdict is downgraded to
     * `success: false` (with error code `hostname-mismatch`). Set this when a
     * single secret/sitekey is shared across multiple domains to stop a token
     * harvested on one origin from being replayed against another. Leave unset
     * to skip the check.
     */
    expectedHostname?: string;

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
 * decide how to react. The function throws a structural `LunoraError`-shaped
 * error (`{ name: "LunoraError", code: "SERVICE_UNAVAILABLE", status: 503 }`)
 * only when the siteverify call itself fails (network error or non-2xx), so a
 * "siteverify is down" failure is distinguishable from a "this is a bot"
 * verdict.
 */
const verifyTurnstile = async ({
    expectedAction,
    expectedHostname,
    fetch = globalThis.fetch,
    remoteip,
    secret,
    token,
}: VerifyTurnstileOptions): Promise<TurnstileVerifyResult> => {
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
        throw new LunoraError("SERVICE_UNAVAILABLE", "turnstile siteverify request failed", { cause: error, status: 503 });
    }

    if (!response.ok) {
        throw new LunoraError("SERVICE_UNAVAILABLE", `turnstile siteverify returned ${String(response.status)}`, { status: 503 });
    }

    const raw: RawSiteverifyResponse = await response.json();

    const action = asString(raw.action);
    const hostname = asString(raw.hostname);
    const errorCodes = asStringArray(raw["error-codes"]);
    let success = raw.success === true;

    // Even a token Cloudflare reports as valid can be a cross-origin/cross-action
    // replay when one secret/sitekey is shared across domains or widgets. Assert
    // the returned `hostname`/`action` against the caller's expectation and
    // downgrade the verdict to a failure (single-use semantics preserved: the
    // token is still spent) when they don't match.
    if (success && expectedHostname !== undefined && hostname !== expectedHostname) {
        success = false;
        errorCodes.push("hostname-mismatch");
    }

    if (success && expectedAction !== undefined && action !== expectedAction) {
        success = false;
        errorCodes.push("action-mismatch");
    }

    return {
        action,
        cdata: asString(raw.cdata),
        challengeTs: asString(raw.challenge_ts),
        errorCodes,
        hostname,
        success,
    };
};

export { TURNSTILE_VERIFY_ENDPOINT, verifyTurnstile };
export type { FetchLike, TurnstileVerifyResult, VerifyTurnstileOptions };
