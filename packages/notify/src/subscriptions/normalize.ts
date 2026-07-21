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

/**
 * Structured "permanently gone" signal from the Web Push provider: an HTTP `404`
 * (Not Found) or `410` (Gone) status. The `@visulima/notification` web-push
 * provider surfaces these as `Subscription gone (HTTP 404|410)` / `HTTP 404|410:`
 * in its failure receipt — the ONLY 4xx statuses that mean the endpoint is dead.
 * Every other status (`400`, `429`, `413`, 5xx, TLS/`ECONNRESET`) is transient or
 * a caller error worth retrying, never a prune.
 */
const WEB_PUSH_GONE_PATTERN = /\bhttp\s*4(?:04|10)\b/iu;

/**
 * Structured "permanently gone" signal from FCM: the canonical `UNREGISTERED`
 * (HTTP v1) / `NotRegistered` (legacy) error codes — a.k.a.
 * `registration-token-not-registered` — meaning the device token is dead.
 */
const FCM_GONE_PATTERN = /\b(?:unregistered|not[\s-]?registered|registration-token-not-registered)\b/iu;

/**
 * Last-resort text fallback for a provider that phrases "gone" in prose without a
 * status/code. Deliberately narrow — it requires the word `subscription`
 * qualifying `gone`/`expired`/`no longer valid`, so a transient message that
 * merely CONTAINS `expired` (`TLS certificate expired`, `session expired, retry`)
 * does NOT trigger a destructive prune.
 */
const GONE_TEXT_FALLBACK = /\bsubscription (?:is )?(?:gone|expired|no longer valid)\b/iu;

/**
 * Whether a provider error message indicates the subscription is permanently gone
 * (the browser/device unsubscribed) and should be pruned — as opposed to a
 * transient failure worth retrying.
 *
 * Gates on STRUCTURED signals first: a Web Push `HTTP 404/410` status or an FCM
 * `UNREGISTERED`/`NOT_REGISTERED` code, both of which the providers surface in
 * their failure receipts. The free-text {@link GONE_TEXT_FALLBACK} is a tightened
 * last resort only, so a transient error that happens to contain `expired`
 * (a cert/session expiry) can never permanently drop a valid subscription.
 */
const isGoneError = (message: string | undefined): boolean => {
    if (message === undefined) {
        return false;
    }

    return WEB_PUSH_GONE_PATTERN.test(message) || FCM_GONE_PATTERN.test(message) || GONE_TEXT_FALLBACK.test(message);
};

export { fcmId, isGoneError, normalizeRegisterInput, targetOf, webPushId };
