/**
 * The authenticated DO→DO control channel, shared by every internal tier that
 * addresses a sibling shard: the relay hub (`/_lunora/relay`) and the read
 * replicas (`/_lunora/replica`).
 *
 * All of it — the namespace duck-type, the HMAC over the raw body, the
 * constant-time verify — exists once here rather than per tier. A second copy
 * of a signing primitive is how two channels end up with two different
 * definitions of "authenticated", and the weaker one is the one that gets
 * exploited.
 *
 * The env var and header keep their original `RELAY` spelling: they are
 * operator-facing configuration on deployments that already provision them, and
 * one secret authenticates the whole internal channel regardless of which tier
 * sends the frame.
 */

import { constantTimeEqual } from "../../../shared/constant-time-equal";

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

/** Minimal Durable Object stub surface an internal tier needs to POST a control frame to a sibling. */
interface SiblingStub {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Minimal Durable Object namespace surface for addressing siblings by name. */
interface SiblingNamespaceLike {
    get: (id: unknown) => SiblingStub;
    getByName?: (name: string) => SiblingStub;
    idFromName: (name: string) => unknown;
}

/** Duck-type a value as a DO namespace, or `undefined` when it isn't one (single-DO mode / unbound). */
const asSiblingNamespace = (value: unknown): SiblingNamespaceLike | undefined => {
    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const candidate = value as Partial<SiblingNamespaceLike>;

    return typeof candidate.idFromName === "function" && typeof candidate.get === "function" ? (candidate as SiblingNamespaceLike) : undefined;
};

/** Resolve a sibling stub by name off the shard namespace binding, or `undefined` when the binding is unknown/unbound. */
const siblingStub = (env: unknown, binding: string | undefined, name: string): SiblingStub | undefined => {
    if (binding === undefined) {
        return undefined;
    }

    const namespace = asSiblingNamespace((env as Record<string, unknown> | undefined)?.[binding]);

    if (namespace === undefined) {
        return undefined;
    }

    return typeof namespace.getByName === "function" ? namespace.getByName(name) : namespace.get(namespace.idFromName(name));
};

export type { SiblingNamespaceLike, SiblingStub };
export { asSiblingNamespace, RELAY_SECRET_KEY, RELAY_SIGNATURE_HEADER, siblingSecretOf, siblingStub, signSiblingBody, verifySiblingBody };
