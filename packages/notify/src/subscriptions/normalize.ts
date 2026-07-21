import { LunoraError } from "@lunora/errors";

import type { RegisterInput, StoredSubscription } from "../types";

/** A loosely-typed parsed subscription — fields are `unknown` until validated. */
interface LooseSubscription {
    endpoint?: unknown;
    keys?: { auth?: unknown; p256dh?: unknown };
}

/**
 * FNV-1a (32-bit) — a tiny, dependency-free, synchronous, edge-safe hash used to
 * derive a compact, deterministic subscription id from its (long) endpoint/token.
 * Deterministic so re-registering the same device upserts rather than duplicates;
 * not security-sensitive (ids are opaque store keys, never a secret).
 */
const fnv1a = (input: string): string => {
    let hash = 0x81_1c_9d_c5;

    for (let index = 0; index < input.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- FNV-1a mixing requires XOR
        hash ^= input.codePointAt(index) ?? 0;
        hash = Math.imul(hash, 0x01_00_01_93);
    }

    // eslint-disable-next-line no-bitwise -- coerce to an unsigned 32-bit int
    return (hash >>> 0).toString(16).padStart(8, "0");
};

/** Stable store id for a web-push endpoint. */
const webPushId = (endpoint: string): string => `wp_${fnv1a(endpoint)}`;

/** Stable store id for an FCM device token. */
const fcmId = (token: string): string => `fcm_${fnv1a(token)}`;

const parseSubscription = (subscription: unknown): LooseSubscription => {
    if (typeof subscription !== "string") {
        return subscription ?? {};
    }

    try {
        return JSON.parse(subscription) as LooseSubscription;
    } catch (error) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/notify: register() web-push subscription is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
};

/**
 * Normalise a `register(...)` input into a {@link StoredSubscription}. Validates
 * the shape (a web-push subscription needs `endpoint` + `keys.{p256dh,auth}`; an
 * FCM entry needs a non-empty `token`) and stamps `createdAt`/`lastSeenAt`.
 */
const normalizeRegisterInput = (input: RegisterInput, now: number = Date.now()): StoredSubscription => {
    if ("token" in input) {
        const { token } = input;

        if (typeof token !== "string" || token === "") {
            throw new LunoraError("BAD_REQUEST", "@lunora/notify: register() fcm input requires a non-empty `token`");
        }

        return { createdAt: now, id: fcmId(token), kind: "fcm", lastSeenAt: now, metadata: input.metadata, token, userId: input.userId ?? null };
    }

    const subscription = parseSubscription(input.subscription);
    const { endpoint } = subscription;
    const p256dh = subscription.keys?.p256dh;
    const auth = subscription.keys?.auth;

    if (typeof endpoint !== "string" || endpoint === "" || typeof p256dh !== "string" || typeof auth !== "string") {
        throw new LunoraError("BAD_REQUEST", "@lunora/notify: register() web-push subscription requires `endpoint` and `keys.{p256dh, auth}`");
    }

    return {
        createdAt: now,
        endpoint,
        id: webPushId(endpoint),
        keys: { auth, p256dh },
        kind: "web-push",
        lastSeenAt: now,
        metadata: input.metadata,
        userId: input.userId ?? null,
    };
};

/**
 * The provider `to` target for a stored subscription: the W3C Push subscription
 * (JSON-stringified) for web-push, or the raw device token for FCM. Matches the
 * shapes the `@visulima/notification` web-push / fcm providers accept.
 */
const targetOf = (subscription: StoredSubscription): string => {
    if (subscription.kind === "fcm") {
        return subscription.token ?? "";
    }

    return JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys });
};

/** Gone/expired signals across Web Push (HTTP 404/410) and FCM (`UNREGISTERED`/`NotRegistered`). */
const GONE_PATTERN = /\b(?:404|410|gone|expired|unregistered|not[\s-]?registered|invalid[\s-]?(?:token|registration))\b/iu;

/**
 * Whether a provider error message indicates the subscription is permanently gone
 * (the browser/device unsubscribed) and should be pruned — as opposed to a
 * transient failure worth retrying. Heuristic over the providers' error text.
 */
const isGoneError = (message: string | undefined): boolean => (message === undefined ? false : GONE_PATTERN.test(message));

export { fcmId, isGoneError, normalizeRegisterInput, targetOf, webPushId };
