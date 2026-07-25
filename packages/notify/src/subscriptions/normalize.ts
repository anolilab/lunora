import { LunoraError } from "@lunora/errors";

import { isPrivateHost } from "../../../../shared/ssrf-host";
import type { RegisterInput, StoredSubscription } from "../types";

/** A loosely-typed parsed subscription — fields are `unknown` until validated. */
interface LooseSubscription {
    endpoint?: unknown;
    keys?: { auth?: unknown; p256dh?: unknown };
}

/** One 16-bit limb of a 64-bit hash as 4 lowercase hex digits. */
const hex4 = (limb: number): string => limb.toString(16).padStart(4, "0");

/**
 * FNV-1a (64-bit) as 16 lowercase hex digits — a tiny, dependency-free,
 * synchronous, edge-safe hash used to derive a compact, deterministic
 * subscription id from its (long) endpoint/token. Deterministic so re-registering
 * the same device upserts rather than duplicates; not security-sensitive (ids are
 * opaque store keys, never a secret).
 *
 * Widened from the previous 32-bit FNV-1a (8 hex): at 100K devices a 32-bit key
 * collides with ~68% probability (birthday bound), and a collision silently
 * overwrites another device's row under the store's `ON CONFLICT(id) DO UPDATE` —
 * so the wrong user gets the push and the victim goes dark. 64 bits drops that to
 * negligible at any realistic device count.
 *
 * The hash state is four 16-bit limbs in plain `number`s (not a `BigInt`, which
 * allocates per op). The FNV-1a prime `0x0000_0100_0000_01b3` has only two
 * non-zero limbs, so the 4×4 limb product collapses to two multiplications per
 * limb; every intermediate stays under 2^32, so `>>> 16` is a valid carry.
 * Algorithm lifted from `@lunora/replica`'s bit-verified `fnv1a64Hex`.
 */
const fnv1a64Hex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    // Offset basis 0xcbf29ce484222325, low limb first.
    let h0 = 0x23_25;
    let h1 = 0x84_22;
    let h2 = 0x9c_e4;
    let h3 = 0xcb_f2;

    for (let index = 0; index < input.length; index += 1) {
        const point = input.codePointAt(index) ?? 0;

        // A code point above the BMP occupies limbs 0 and 1.
        h0 ^= point & 0xff_ff;
        h1 ^= (point >>> 16) & 0xff_ff;

        const p0 = h0 * 0x01_b3;
        const p1 = h1 * 0x01_b3;
        const p2 = h2 * 0x01_b3 + h0 * 0x01_00;
        const p3 = h3 * 0x01_b3 + h1 * 0x01_00;

        const c1 = p1 + (p0 >>> 16);
        const c2 = p2 + (c1 >>> 16);
        const c3 = p3 + (c2 >>> 16);

        h0 = p0 & 0xff_ff;
        h1 = c1 & 0xff_ff;
        h2 = c2 & 0xff_ff;
        h3 = c3 & 0xff_ff;
    }

    return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
    /* eslint-enable no-bitwise */
};

/**
 * Stable store id for a web-push endpoint.
 *
 * The `wp2_` prefix is a version tag (see also {@link fcmId}'s `fcm2_`): it marks
 * the 64-bit-id revision so the pre-existing 32-bit `wp_` rows stay readable and a
 * returning device simply re-registers under the new id, its stale `wp_` row aging
 * out via normal gone-pruning. A future third revision must mint `wp3_` and repeat
 * the lazy migration — NEVER reuse a prefix.
 */
const webPushId = (endpoint: string): string => `wp2_${fnv1a64Hex(endpoint)}`;

/** Stable store id for an FCM device token. See {@link webPushId} for the `_2` version-prefix contract. */
const fcmId = (token: string): string => `fcm2_${fnv1a64Hex(token)}`;

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

/** Options threaded into {@link normalizeRegisterInput} from the notify definition. */
interface NormalizeOptions {
    /**
     * Exact origins (`https://host[:port]`) a web-push endpoint may register from.
     * When set (non-empty), the endpoint's origin must be one of these — the
     * strongest anti-SSRF posture. When unset, the default posture applies:
     * `https:` scheme + a non-private/non-loopback host.
     */
    allowedPushOrigins?: string[];
}

/**
 * Validate a client-supplied Web Push `endpoint` before it is STORED — the durable
 * SSRF boundary. Every later `send`/`broadcast` POSTs to this URL, so a stored
 * `http://internal-host/…` (or `https://169.254.169.254/…`) turns the worker into
 * an SSRF / amplification primitive. Rejected at register time so a bad endpoint
 * never reaches the store, not merely at send time.
 *
 * It must parse as an absolute `https:` URL (rejecting `http:` and every other
 * scheme — Web Push endpoints are always `https:`), and its host must not be
 * loopback / private / link-local / CGNAT / reserved (see the shared
 * `isPrivateHost` classifier). When `allowedPushOrigins` is configured, the
 * endpoint's origin must instead match one of those exactly — a hard allowlist
 * that also closes DNS rebinding.
 */
const assertPushEndpoint = (endpoint: string, allowedPushOrigins?: string[]): void => {
    let url: URL;

    try {
        url = new URL(endpoint);
    } catch {
        throw new LunoraError("BAD_REQUEST", `@lunora/notify: register() web-push \`endpoint\` must be an absolute https URL (got "${endpoint}")`);
    }

    if (url.protocol !== "https:") {
        throw new LunoraError("BAD_REQUEST", `@lunora/notify: register() web-push \`endpoint\` must use https (got "${url.protocol}")`);
    }

    if (allowedPushOrigins !== undefined && allowedPushOrigins.length > 0) {
        if (!allowedPushOrigins.includes(url.origin)) {
            throw new LunoraError(
                "FORBIDDEN",
                `@lunora/notify: register() web-push endpoint origin "${url.origin}" is not in the configured allowedPushOrigins allowlist`,
            );
        }

        return;
    }

    if (isPrivateHost(url.hostname)) {
        throw new LunoraError(
            "FORBIDDEN",
            `@lunora/notify: register() web-push endpoint host "${url.hostname}" is a private/internal address; configure allowedPushOrigins to permit a specific origin`,
        );
    }
};

/**
 * Normalise a `register(...)` input into a {@link StoredSubscription}. Validates
 * the shape (a web-push subscription needs `endpoint` + `keys.{p256dh,auth}`; an
 * FCM entry needs a non-empty `token`), enforces the anti-SSRF endpoint boundary
 * (see {@link assertPushEndpoint}), and stamps `createdAt`/`lastSeenAt`.
 */
const normalizeRegisterInput = (input: RegisterInput, now: number = Date.now(), options: NormalizeOptions = {}): StoredSubscription => {
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

    assertPushEndpoint(endpoint, options.allowedPushOrigins);

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
