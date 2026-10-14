/**
 * Webhook signature verification primitives.
 *
 * Verification runs over the **raw, unparsed request body** — never re-serialize JSON before
 * checking the signature. Uses WebCrypto (`crypto.subtle`), available in both workerd and Node.
 */
import { fromBase64, toBase64 } from "../../../shared/base64";
import { constantTimeEqual as sharedConstantTimeEqual } from "../../../shared/constant-time-equal";
import { LunoraPaymentError } from "./errors";

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const SYMMETRIC_PREFIX = "whsec_";

const hmacSha256Base64 = async (keyBytes: BufferSource, payload: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", keyBytes, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    return toBase64(new Uint8Array(signature));
};

/** The Standard Webhooks key: `whsec_` dropped, the remainder base64-decoded. */
const standardWebhookKey = (secret: string): ReturnType<typeof fromBase64> => {
    const rawSecret = secret.startsWith(SYMMETRIC_PREFIX) ? secret.slice(SYMMETRIC_PREFIX.length) : secret;
    let keyBytes: ReturnType<typeof fromBase64>;

    try {
        keyBytes = fromBase64(rawSecret);
    } catch {
        // A secret that is not base64 is a configuration error, not a bad delivery: surfacing
        // the decoder's `Invalid character` as a 400 sent operators hunting for a forged request.
        throw new LunoraPaymentError("CONFIG_INVALID", "webhook secret is not base64 (expected whsec_<base64>)");
    }

    if (keyBytes.length === 0) {
        throw new LunoraPaymentError("CONFIG_INVALID", "webhook secret not configured");
    }

    return keyBytes;
};

/**
 * Fail closed on an empty/missing webhook secret. A zero-length HMAC key is attacker-known, so a
 * deployment whose secret is bound-but-empty (an unset `.dev.vars` line, a wrangler var set to `""`,
 * a CI secret that resolved empty) would otherwise accept forged events. Every adapter's
 * verification path routes through this one check — some SDKs (Stripe's included) do not validate
 * the secret themselves, and on some runtimes an empty key merely happens to make `importKey` throw.
 */
export const assertWebhookSecret = (secret: string): void => {
    if (!secret) {
        throw new LunoraPaymentError("CONFIG_INVALID", "webhook secret not configured");
    }
};

/**
 * Constant-time string comparison to avoid leaking byte positions via timing.
 *
 * Re-exported from `shared/constant-time-equal` rather than defined here. The
 * copy that used to live at this spot returned early on a length mismatch, so
 * an attacker learned the expected signature's LENGTH from the response time —
 * the exact divergence that shared file was created to stop, and which it
 * records having already fixed once in the relay hub. It also compared by code
 * POINT, making timing depend on surrogate boundaries; the canonical one
 * compares per UTF-16 code unit.
 */
export const constantTimeEqual: (a: string, b: string) => boolean = sharedConstantTimeEqual;

/**
 * Hex-encoded `HMAC_SHA256(secret, payload)` — the primitive behind the hex-scheme
 * webhook verifiers.
 */
export const hmacSha256Hex = async (secret: string, payload: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    return toHex(signature);
};

export interface VerifyStandardWebhookInput {
    /**
     * How `secret` becomes the HMAC key.
     *
     * `"base64"` (default) is the Standard Webhooks convention: an optional `whsec_` prefix is
     * dropped and the remainder is base64-decoded. Dodo Payments, Autumn and svix issue secrets in
     * this form.
     *
     * `"utf8"` uses the secret's UTF-8 bytes verbatim, prefix included. Polar signs this way: its
     * SDK base64-ENCODES the secret before handing it to the Standard Webhooks verifier, which
     * decodes it straight back, so the key is the secret as typed (`polar_whs_…` included).
     */
    readonly keyEncoding?: "base64" | "utf8";
    /** Injectable clock (ms since epoch) for tests. */
    readonly now?: number;
    /** Raw request body, exactly as received. */
    readonly payload: string;
    /** Endpoint secret; turned into the HMAC key per {@link VerifyStandardWebhookInput.keyEncoding}. */
    readonly secret: string;
    /** Whole-second tolerance for the signed timestamp (default 300). */
    readonly toleranceSeconds?: number;
    /** `webhook-id` header. */
    readonly webhookId: string;
    /** `webhook-signature` header — space-separated `v1,<base64>` entries. */
    readonly webhookSignature: string;
    /** `webhook-timestamp` header — unix seconds as a string. */
    readonly webhookTimestamp: string;
}

/**
 * Verify a Standard Webhooks signature (the scheme Polar and svix use):
 * `base64(HMAC_SHA256(key, "{id}.{timestamp}.{payload}"))` compared against the header's `v1`
 * entries, with a replay-window check. Throws a {@link LunoraPaymentError} on any failure.
 */
export const verifyStandardWebhook = async (input: VerifyStandardWebhookInput): Promise<void> => {
    assertWebhookSecret(input.secret);

    const toleranceSeconds = input.toleranceSeconds ?? 300;
    const nowMs = input.now ?? Date.now();
    const timestamp = Number(input.webhookTimestamp);

    if (!input.webhookId || !input.webhookSignature || !Number.isFinite(timestamp)) {
        throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "missing standard-webhooks headers");
    }

    if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceSeconds) {
        throw new LunoraPaymentError("WEBHOOK_TIMESTAMP_INVALID", "signature timestamp outside tolerance");
    }

    const keyBytes = input.keyEncoding === "utf8" ? encoder.encode(input.secret) : standardWebhookKey(input.secret);

    const expected = await hmacSha256Base64(keyBytes, `${input.webhookId}.${input.webhookTimestamp}.${input.payload}`);
    const provided = input.webhookSignature
        .split(" ")
        .map((entry) => {
            const comma = entry.indexOf(",");

            return comma === -1 ? "" : entry.slice(comma + 1);
        })
        .filter(Boolean);

    if (!provided.some((candidate) => constantTimeEqual(candidate, expected))) {
        throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "no matching signature");
    }
};

export interface VerifyCreemSignatureInput {
    /** Raw request body, exactly as received. */
    readonly payload: string;
    /** Creem webhook signing secret. */
    readonly secret: string;
    /** The `creem-signature` header value. */
    readonly signature: string;
}

/**
 * Verify a Creem webhook signature: `hex(HMAC_SHA256(secret, rawBody))` compared against the
 * `creem-signature` header. Creem's scheme signs the raw body with no timestamp, so there is no
 * replay-window check. Throws a {@link LunoraPaymentError} on any failure.
 */
export const verifyCreemSignature = async (input: VerifyCreemSignatureInput): Promise<void> => {
    assertWebhookSecret(input.secret);

    if (!input.signature) {
        throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "missing creem-signature header");
    }

    const expected = await hmacSha256Hex(input.secret, input.payload);

    if (!constantTimeEqual(input.signature, expected)) {
        throw new LunoraPaymentError("WEBHOOK_SIGNATURE_INVALID", "no matching signature");
    }
};
