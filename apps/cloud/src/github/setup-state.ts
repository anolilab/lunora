/**
 * The signed state that proves a GitHub App installation was started by a
 * signed-in owner or admin of one organization. `GET /v1/github/install` signs
 * it, GitHub carries it through the install screens, and `GET /v1/github/setup`
 * verifies it before binding the installation. Nothing else proves a claim, so
 * a staged installation id alone never links an organization.
 *
 * Token: the payload JSON as hex, a dot, then the HMAC-SHA256 of that JSON as hex
 * under the secret. The MAC covers the exact payload bytes, so no canonical form
 * is needed.
 */
import { constantTimeEqual } from "../security/constant-time-equal";

/** How long an install may take from start to callback. Long enough for GitHub's install screens, short enough that a leaked link goes stale. */
export const SETUP_STATE_TTL_MS = 10 * 60 * 1000;

/** What a signed install state names. Only these fields are trusted once the MAC verifies. */
export interface SetupState {
    expiresAt: number;
    nonce: string;
    organizationId: string;
    userId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/u;

const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

/**
 * The HMAC key from the secret. Refuses an empty secret: a MAC keyed with the
 * empty string is one anyone can reproduce, so a missing secret must never sign.
 */
const hmacKey = (secret: string | undefined, usage: "sign" | "verify"): Promise<CryptoKey> => {
    if (!secret) {
        throw new Error("GITHUB_SETUP_STATE_SECRET is not configured");
    }

    return crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [usage]);
};

const macOf = async (payload: string, secret: string | undefined): Promise<string> => {
    const key = await hmacKey(secret, "sign");

    return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
};

const parseState = (payload: string): null | SetupState => {
    let value: unknown;

    try {
        value = JSON.parse(payload);
    } catch {
        return null;
    }

    if (typeof value !== "object" || value === null) {
        return null;
    }

    const { expiresAt, nonce, organizationId, userId } = value as Record<string, unknown>;

    if (typeof expiresAt !== "number" || typeof nonce !== "string" || typeof organizationId !== "string" || typeof userId !== "string") {
        return null;
    }

    return { expiresAt, nonce, organizationId, userId };
};

/** Sign an install state. Throws when the secret is unset. */
export const signSetupState = async (state: SetupState, secret: string | undefined): Promise<string> => {
    // Key order is fixed by this literal, so the payload is the same bytes every time.
    const payload = JSON.stringify({ expiresAt: state.expiresAt, nonce: state.nonce, organizationId: state.organizationId, userId: state.userId });

    return `${toHex(encoder.encode(payload))}.${await macOf(payload, secret)}`;
};

/**
 * The state a token names, or `null` when it is malformed, tampered with, signed
 * under another secret, or past its expiry. Throws when the secret is unset.
 */
export const verifySetupState = async (token: string, secret: string | undefined, now: number): Promise<null | SetupState> => {
    const [payloadHex = "", mac = "", ...rest] = token.split(".");

    if (payloadHex === "" || mac === "" || rest.length > 0 || !HEX_BYTES.test(payloadHex)) {
        return null;
    }

    const payload = decoder.decode(hexToBytes(payloadHex));

    if (!constantTimeEqual(await macOf(payload, secret), mac)) {
        return null;
    }

    const state = parseState(payload);

    return state === null || state.expiresAt <= now ? null : state;
};
