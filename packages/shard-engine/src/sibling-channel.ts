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

    /**
     * Jurisdiction-restricted subnamespace (`env.SHARD.jurisdiction("eu")`).
     * Optional: absent on an older `workers-types`, in workerd, and on the test
     * doubles — {@link siblingStub} treats absence as "cannot address a sibling
     * in that jurisdiction" rather than silently using the unrestricted binding.
     */
    jurisdiction?: (jurisdiction: string) => SiblingNamespaceLike;
}

/** Duck-type a value as a DO namespace, or `undefined` when it isn't one (single-DO mode / unbound). */
const asSiblingNamespace = (value: unknown): SiblingNamespaceLike | undefined => {
    if (value === null || typeof value !== "object") {
        return undefined;
    }

    const candidate = value as Partial<SiblingNamespaceLike>;

    return typeof candidate.idFromName === "function" && typeof candidate.get === "function" ? (candidate as SiblingNamespaceLike) : undefined;
};

/**
 * Resolve a sibling stub by name off the shard namespace binding, or
 * `undefined` when the binding is unknown/unbound.
 *
 * `jurisdiction` is the residency this DO itself was created under, read off
 * its own `ctx.id.jurisdiction`. It MUST be applied here: a jurisdiction
 * subnamespace maps a name to a DIFFERENT `DurableObjectId` than the
 * unrestricted binding does (Cloudflare documents
 * `ns.idFromName(n) !== ns.jurisdiction("eu").idFromName(n)`), and the worker
 * pins every namespace it routes through while stamping the RAW env key as
 * `x-lunora-shard-binding`. Resolving off that raw binding therefore addressed
 * a *different DO than the owner* — an empty stranger outside the declared
 * jurisdiction. A replica bootstrapping against it saw no changelog and fell
 * back to owner reads forever; a relay frame was delivered nowhere. The DO's
 * own id is the one place the residency is knowable inside the DO, and it is
 * exactly the subnamespace its siblings live in.
 *
 * Fails closed when a jurisdiction is in force but the binding cannot express
 * one: `undefined` leaves the tier inert (reads fall back to the worker-routed
 * owner, which IS pinned) rather than opening a stub outside the compliance
 * boundary. In practice this cannot fire on a host that has no jurisdictions —
 * there `ctx.id.jurisdiction` is unset and nothing is applied.
 */
const siblingStub = (env: unknown, binding: string | undefined, name: string, jurisdiction?: string): SiblingStub | undefined => {
    if (binding === undefined) {
        return undefined;
    }

    const bound = asSiblingNamespace((env as Record<string, unknown> | undefined)?.[binding]);

    if (bound === undefined) {
        return undefined;
    }

    const namespace = jurisdiction === undefined ? bound : asSiblingNamespace(bound.jurisdiction?.(jurisdiction));

    if (namespace === undefined) {
        return undefined;
    }

    return typeof namespace.getByName === "function" ? namespace.getByName(name) : namespace.get(namespace.idFromName(name));
};

export type { SiblingNamespaceLike, SiblingStub };
export { asSiblingNamespace, RELAY_SECRET_KEY, RELAY_SIGNATURE_HEADER, siblingSecretOf, siblingStub, signSiblingBody, verifySiblingBody };
