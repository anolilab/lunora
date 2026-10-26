/**
 * The HMAC relay signature shared by every package that signs or verifies a
 * control frame: the shard engine's sibling channel, the event log, and its
 * client. Zero-dependency (bundler-inlined) so a package that needs only the
 * signature does not take a dependency on the shard engine.
 */

import { constantTimeEqual } from "./constant-time-equal";

/** Env var carrying the optional internal control-channel HMAC secret. */
const RELAY_SECRET_KEY = "LUNORA_RELAY_SECRET";

/** Header carrying the hex HMAC-SHA256 of an internal control-frame body. */
const RELAY_SIGNATURE_HEADER = "x-lunora-relay-sig";

/** The internal control-channel secret, or `undefined` when message authentication is not configured. */
const siblingSecretOf = (env: unknown): string | undefined => {
    const value = (env as Record<string, unknown> | undefined)?.[RELAY_SECRET_KEY];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * HMAC-SHA256 of `body` under `secret`, hex-encoded. Authenticates the internal
 * control channel (L6): without it, safety rests solely on DO network
 * isolation, so any DO in the namespace (or a future custom route that
 * forwarded a client path+body to a shard) could inject forged frames — e.g.
 * deliver an arbitrary `rowsPatch` to another subscriber's socket, or feed a
 * replica a fabricated change batch. Opt-in: only enforced when
 * `LUNORA_RELAY_SECRET` is set, so existing deployments are unaffected until
 * they provision the secret.
 */
const signSiblingBody = async (secret: string, body: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Whether `raw` may be dispatched: true when no secret is configured (legacy
 * network-trust), or when `supplied` is a valid signature over the exact bytes
 * received. Fails closed on a missing or mismatched signature.
 */
const verifySiblingBody = async (env: unknown, supplied: null | string, raw: string): Promise<boolean> => {
    const secret = siblingSecretOf(env);

    if (secret === undefined) {
        return true;
    }

    if (supplied === null) {
        return false;
    }

    return constantTimeEqual(supplied, await signSiblingBody(secret, raw));
};

export { RELAY_SIGNATURE_HEADER, siblingSecretOf, signSiblingBody, verifySiblingBody };
