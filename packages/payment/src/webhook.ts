/**
 * Webhook signature verification primitives.
 *
 * Verification runs over the **raw, unparsed request body** — never re-serialize JSON before
 * checking the signature. Uses WebCrypto (`crypto.subtle`), available in both workerd and Node.
 */
import { CirrusPaymentError } from "./errors";

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison to avoid leaking byte positions via timing. */
export const constantTimeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let mismatch = 0;

    for (let index = 0; index < a.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- constant-time accumulation is the point
        mismatch |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
    }

    return mismatch === 0;
};

export const hmacSha256Hex = async (secret: string, payload: string): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    return toHex(signature);
};

export interface StripeSignatureParts {
    readonly signatures: string[];
    readonly timestamp: number;
}

/** Parse a Stripe-style `t=...,v1=...,v1=...` signature header. */
export const parseStripeSignatureHeader = (header: string): StripeSignatureParts => {
    let timestamp = Number.NaN;
    const signatures: string[] = [];

    for (const part of header.split(",")) {
        const index = part.indexOf("=");

        if (index === -1) {
            continue;
        }

        const scheme = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        if (scheme === "t") {
            timestamp = Number(value);
        } else if (scheme === "v1") {
            signatures.push(value);
        }
    }

    return { signatures, timestamp };
};

export interface VerifyStripeSignatureInput {
    /** Injectable clock (ms since epoch) for tests. */
    readonly now?: number;
    /** Raw request body, exactly as received. */
    readonly payload: string;
    readonly secret: string;
    /** The `Stripe-Signature` header value. */
    readonly signatureHeader: string;
    /** Whole-second tolerance for the signed timestamp (default 300). */
    readonly toleranceSeconds?: number;
}

/**
 * Verify a Stripe-scheme webhook signature: `HMAC_SHA256(secret, "{t}.{payload}")` compared
 * against the header's `v1` values, with a timestamp tolerance to reject replays. Throws a
 * {@link CirrusPaymentError} on any failure.
 */
export const verifyStripeSignature = async (input: VerifyStripeSignatureInput): Promise<void> => {
    const toleranceSeconds = input.toleranceSeconds ?? 300;
    const nowMs = input.now ?? Date.now();
    const { signatures, timestamp } = parseStripeSignatureHeader(input.signatureHeader);

    if (!Number.isFinite(timestamp) || signatures.length === 0) {
        throw new CirrusPaymentError("WEBHOOK_SIGNATURE_INVALID", "malformed signature header");
    }

    if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > toleranceSeconds) {
        throw new CirrusPaymentError("WEBHOOK_TIMESTAMP_INVALID", "signature timestamp outside tolerance");
    }

    const expected = await hmacSha256Hex(input.secret, `${String(timestamp)}.${input.payload}`);

    if (!signatures.some((candidate) => constantTimeEqual(candidate, expected))) {
        throw new CirrusPaymentError("WEBHOOK_SIGNATURE_INVALID", "no matching signature");
    }
};
