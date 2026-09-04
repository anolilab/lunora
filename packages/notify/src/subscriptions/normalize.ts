import { LunoraError } from "@lunora/errors";

import { fnv1a64Hex, fnv1aHex } from "../../../../shared/fnv1a";
import { isPrivateHost } from "../../../../shared/ssrf-host";
import type { RegisterInput, StoredSubscription } from "../types";

/** A loosely-typed parsed subscription — fields are `unknown` until validated. */
interface LooseSubscription {
    endpoint?: unknown;
    keys?: { auth?: unknown; p256dh?: unknown };
}

/**
 * Cap on a `register()` input's serialised `metadata` size (NOTIFY-02): a
 * client controls this field end-to-end, and it is `JSON.stringify`'d
 * straight into the D1 row with no prior shape/size check, so an
 * unbounded value lets a client persist an arbitrarily large blob per
 * subscription. A few KB is comfortably enough for the documented use
 * (device name, locale, topic tags) while bounding worst-case row growth.
 */
const MAX_METADATA_BYTES = 4096;

/**
 * Cap on each client-controlled DELIVERY field written to the same row
 * (NOTIFY-02, second half): the Web Push `endpoint`, the FCM `token` and the
 * RFC 8291 `keys`. These are as client-controlled as `metadata` and land in the
 * same D1 row, so capping only `metadata` bounded nothing — a 4 KB `metadata`
 * was refused while a 1 MB `endpoint` and a 2 MB `token` went straight in.
 *
 * The caps are generous against reality so no live device is refused: a real
 * push endpoint is ~200 bytes and an FCM registration token ~160, while the
 * RFC 8291 keys are fixed-width base64url (`p256dh` 87 chars, `auth` 22).
 */
const MAX_ENDPOINT_BYTES = 2048;
const MAX_TOKEN_BYTES = 2048;
const MAX_KEY_BYTES = 512;

/** Refuse a client-supplied string field that exceeds its byte cap (see {@link MAX_ENDPOINT_BYTES}). */
const assertFieldSize = (value: string, max: number, field: string): void => {
    const byteLength = new TextEncoder().encode(value).length;

    if (byteLength > max) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/notify: register() \`${field}\` is ${byteLength.toString()} bytes, exceeding the ${max.toString()}-byte cap`,
        );
    }
};

/**
 * Validate a `register()` input's `metadata` (NOTIFY-02) before it is
 * STORED: must be a plain object (not an array, class instance, or
 * primitive — those are legal `typeof "object"` values a client could send
 * despite the `Record<string, unknown>` type, since the input crosses an RPC
 * boundary untyped at runtime), must be JSON-serialisable (a circular
 * reference or a `BigInt` value makes `JSON.stringify` throw), and its
 * serialised form must not exceed {@link MAX_METADATA_BYTES}.
 *
 * Serialising here — ONCE, at validation time — rather than leaving it to
 * the store means the later `JSON.stringify(subscription.metadata)` inside
 * `d1SubscriptionStore.put` (a pure, deterministic re-serialisation of the
 * SAME already-proven-serialisable object) can no longer throw mid-write: by
 * the time a `StoredSubscription` reaches any store, its `metadata` has
 * already round-tripped through `JSON.stringify` successfully once here.
 */
const validateMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
    if (metadata === undefined) {
        return undefined;
    }

    const prototype: unknown = typeof metadata === "object" && metadata !== null ? Object.getPrototypeOf(metadata) : undefined;
    const isPlainObject =
        typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) && (prototype === Object.prototype || prototype === null);

    if (!isPlainObject) {
        throw new LunoraError("BAD_REQUEST", "@lunora/notify: register() `metadata` must be a plain object");
    }

    let serialized: string;

    try {
        serialized = JSON.stringify(metadata);
    } catch (error) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/notify: register() \`metadata\` is not JSON-serialisable: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const byteLength = new TextEncoder().encode(serialized).length;

    if (byteLength > MAX_METADATA_BYTES) {
        throw new LunoraError(
            "BAD_REQUEST",
            `@lunora/notify: register() \`metadata\` is ${byteLength.toString()} bytes, exceeding the ${MAX_METADATA_BYTES.toString()}-byte cap`,
        );
    }

    return metadata as Record<string, unknown>;
};

/**
 * Stable store id for a web-push endpoint — `fnv1a64Hex` of the (long) endpoint,
 * so re-registering the same device upserts rather than duplicates.
 *
 * The digest comes from the canonical `shared/fnv1a`, not a local copy. This id
 * is a PERSISTED primary key: a digest that drifts in one copy silently re-keys
 * every existing subscription — the old row goes dark and the device
 * re-registers as a duplicate — so the implementation must have exactly one
 * home. `shared/fnv1a`'s is bit-verified against a BigInt reference in
 * `packages/replica/__tests__/apply-diff.test.ts`.
 *
 * Widened from the previous 32-bit FNV-1a (8 hex): at 100K devices a 32-bit key
 * collides with ~68% probability (birthday bound), and a collision silently
 * overwrites another device's row under the store's `ON CONFLICT(id) DO UPDATE` —
 * so the wrong user gets the push and the victim goes dark. 64 bits drops that to
 * negligible at any realistic device count.
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

/**
 * The delivery kind a store id encodes, or `undefined` for an id this package did
 * not mint (a hand-built {@link StoredSubscription}, or a future scheme).
 *
 * Lives HERE, next to the minters and the legacy prefixes, so the mapping has one
 * home. It exists for the one caller that has an id and a receipt but no row: a
 * `retryIds` job answers per subscription id, and `isGoneError`'s provider-scoping
 * needs the kind that id was minted for.
 */
const kindOfId = (id: string): StoredSubscription["kind"] | undefined => {
    if (id.startsWith("fcm2_") || id.startsWith("fcm_")) {
        return "fcm";
    }

    return id.startsWith("wp2_") || id.startsWith("wp_") ? "web-push" : undefined;
};

/**
 * The PREVIOUS 32-bit FNV-1a digest (8 hex) — the pre-`_2` id scheme. Kept ONLY so
 * a canonical `put` can evict the stale legacy-prefix row for the same identity (see
 * {@link legacyIdFor}).
 *
 * It has to reproduce the old algorithm byte-for-byte or it deletes the wrong row (or
 * none) and the duplicate-broadcast bug survives. That used to be a hand-maintained
 * copy of the algorithm with the requirement stated in prose; it now delegates to
 * `shared/fnv1a.ts`, which is the same digest the studio's mask preview and the
 * server's `"hash"` strategy use — so the requirement is enforced by there being one
 * implementation rather than by this comment being read.
 */
const fnv1a32Hex = (input: string): string => fnv1aHex(input);

/** The legacy (32-bit) store id a web-push endpoint had under the pre-`wp2_` scheme. */
const legacyWebPushId = (endpoint: string): string => `wp_${fnv1a32Hex(endpoint)}`;

/** The legacy (32-bit) store id an FCM token had under the pre-`fcm2_` scheme. */
const legacyFcmId = (token: string): string => `fcm_${fnv1a32Hex(token)}`;

/**
 * The legacy-prefix (`wp_`/`fcm_`) store id for the SAME device identity a canonical
 * {@link StoredSubscription} targets, or `undefined` when it can't be derived (no
 * endpoint/token). A canonical `put` DELETES this id so a device that migrated from
 * the 32-bit scheme to the 64-bit `wp2_`/`fcm2_` scheme is not left as two rows: the
 * legacy row has a different PK, so the upsert's `ON CONFLICT(id)` never touches it,
 * and `broadcast` (which filters by no id) would otherwise deliver to it twice forever.
 */
const legacyIdFor = (subscription: StoredSubscription): string | undefined => {
    if (subscription.kind === "fcm") {
        return subscription.token === undefined ? undefined : legacyFcmId(subscription.token);
    }

    return subscription.endpoint === undefined ? undefined : legacyWebPushId(subscription.endpoint);
};

/**
 * The error a `put` that would move a stored subscription to a different owner
 * must fail with, or `undefined` when the claim is allowed — the shared owner
 * predicate both stores enforce (see `SubscriptionStore.put`).
 *
 * Returned rather than thrown so each store can surface it in its own shape: the
 * D1 store is inside an `async` function and throws it; the in-memory one is a
 * synchronous arrow typed as returning a promise, and a bare throw there escapes
 * a `.catch()` the interface promises.
 *
 * `stored` is the row as it exists AFTER the store's own conditional write, so
 * this doubles as the refusal DETECTOR for a store whose write is silent when the
 * predicate fails (D1's `ON CONFLICT … DO UPDATE … WHERE`): a stored owner that
 * still disagrees with the one just written is a write that did not land. In the
 * memory store it is called before the write instead, on the row as found. Either
 * way the answer is the same, because the ONLY way the two can disagree is a
 * refusal.
 *
 * A row with no owner is claimable (the device signed in); a row this caller
 * already owns is theirs to refresh. Everything else throws, loudly rather than
 * silently, because unlike `unregister` there is nothing safe to return: the
 * caller's own record is what `register` echoes back, and the stored row is
 * someone else's delivery keys.
 */
const claimRefusal = (stored: StoredSubscription | undefined, incoming: StoredSubscription): LunoraError | undefined => {
    const owner = stored?.userId ?? null;

    if (stored === undefined || owner === null || owner === (incoming.userId ?? null)) {
        return undefined;
    }

    return new LunoraError(
        "FORBIDDEN",
        `@lunora/notify: subscription "${incoming.id}" is registered to a different user; a device must be unregistered by its owner before another account can claim it`,
    );
};

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
     * strongest anti-SSRF posture, and the ONLY way to close DNS rebinding for a
     * facade that accepts client-controlled endpoints.
     *
     * When unset, the default posture applies: `https:` scheme + a host the
     * {@link assertPushEndpoint} STRING classifier does not flag as
     * private/loopback, plus a resolved-address re-check at send time. Setting
     * this allowlist replaces both with an exact-origin match — the hard
     * guarantee, and the only one that also covers an internal push service you
     * deliberately want to reach.
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
 *
 * LIMIT OF THIS CHECK: `isPrivateHost` is a STRING classifier — it inspects the
 * host AS-WRITTEN and does NOT resolve DNS. So a PUBLIC hostname that resolves
 * (via attacker-controlled DNS) to a private/internal IP — e.g.
 * `https://127.0.0.1.nip.io/…` or `https://169-254-169-254.sslip.io/…` — is NOT
 * blocked here. That (classic DNS-rebinding) gap is closed at SEND time instead,
 * where the resolved address is re-checked before the POST goes out (see
 * `assertPushTargetResolvable` in `../providers.ts`) — register time is the wrong
 * place for it, since a host that resolves public now can be re-pointed later.
 * A configured `allowedPushOrigins` allowlist remains the hard guarantee.
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
 * (see {@link assertPushEndpoint}), validates `metadata` (see
 * {@link validateMetadata}), and stamps `createdAt`/`lastSeenAt`.
 */
const normalizeRegisterInput = (input: RegisterInput, now: number = Date.now(), options: NormalizeOptions = {}): StoredSubscription => {
    // `kind` is the DECLARED discriminator (see `RegisterInput`), so branch on it
    // and fall back to the token's presence only when it is absent. Branching on
    // `"token" in input` alone routed `{ ...spread, token: undefined }` — a
    // web-push registration whose source object merely declares an optional token
    // field — into the FCM path, where it was rejected as a missing token.
    const isFcm = input.kind === undefined ? (input as { token?: unknown }).token !== undefined : input.kind === "fcm";

    if (isFcm) {
        const { token } = input as { token?: unknown };

        if (typeof token !== "string" || token === "") {
            throw new LunoraError("BAD_REQUEST", "@lunora/notify: register() fcm input requires a non-empty `token`");
        }

        assertFieldSize(token, MAX_TOKEN_BYTES, "token");

        return {
            createdAt: now,
            id: fcmId(token),
            kind: "fcm",
            lastSeenAt: now,
            metadata: validateMetadata(input.metadata),
            token,
            userId: input.userId ?? null,
        };
    }

    const subscription = parseSubscription((input as { subscription?: unknown }).subscription);
    const { endpoint } = subscription;
    const p256dh = subscription.keys?.p256dh;
    const auth = subscription.keys?.auth;

    if (typeof endpoint !== "string" || endpoint === "" || typeof p256dh !== "string" || typeof auth !== "string") {
        throw new LunoraError("BAD_REQUEST", "@lunora/notify: register() web-push subscription requires `endpoint` and `keys.{p256dh, auth}`");
    }

    assertFieldSize(endpoint, MAX_ENDPOINT_BYTES, "endpoint");
    assertFieldSize(auth, MAX_KEY_BYTES, "keys.auth");
    assertFieldSize(p256dh, MAX_KEY_BYTES, "keys.p256dh");
    assertPushEndpoint(endpoint, options.allowedPushOrigins);

    return {
        createdAt: now,
        endpoint,
        id: webPushId(endpoint),
        keys: { auth, p256dh },
        kind: "web-push",
        lastSeenAt: now,
        metadata: validateMetadata(input.metadata),
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
 * "Permanently gone" signal from FCM: the canonical `UNREGISTERED` (HTTP v1) /
 * `NotRegistered` (legacy) error codes — a.k.a.
 * `registration-token-not-registered` — plus the HTTP v1 `NOT_FOUND` PROSE,
 * meaning the device token is dead.
 *
 * The prose alternative is not a nicety, it is the only branch that ever fires
 * against the real transport. `@visulima/notification`'s FCM provider surfaces
 * `body.error.message` and nothing else, while FCM HTTP v1 answers a dead token
 * with HTTP 404, `error.status: "NOT_FOUND"`, `error.message: "Requested entity
 * was not found."` and the `UNREGISTERED` code inside `error.details[].errorCode`
 * — a field the provider drops. So the codes above can only arrive from a
 * different/legacy transport, and matching them alone left FCM pruning inert:
 * every uninstalled device stayed in the store forever, re-POSTed on every
 * broadcast, while the README, the docs and `LunoraPush.broadcast`'s JSDoc all
 * promised it was pruned.
 *
 * Scoped to FCM by {@link isGoneError}'s `kind`, for the same reason the codes
 * are: the web-push provider echoes the push service's response body into
 * `HTTP ${status}: ${body}`, where "not found" is ordinary transient prose.
 */
const FCM_GONE_PATTERN = /\b(?:unregistered|not[\s-]?registered|registration-token-not-registered|requested entity was not found)\b/iu;

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
 * Gates on STRUCTURED signals first: an `HTTP 404/410` status (both providers
 * answer one for a dead endpoint/token, though FCM's is usually replaced by its
 * error body before it reaches here) or, for FCM only, an
 * `UNREGISTERED`/`NOT_REGISTERED` code or the `NOT_FOUND` prose that is the one
 * signal its provider actually forwards (see {@link FCM_GONE_PATTERN}). The
 * free-text {@link GONE_TEXT_FALLBACK} is a tightened last resort only, so a
 * transient error that happens to contain `expired` (a cert/session expiry) can
 * never permanently drop a valid subscription.
 *
 * `kind` scopes the PROVIDER-SPECIFIC patterns to the provider that emits them.
 * The web-push provider echoes the push service's response body into
 * `HTTP ${status}: ${body}`, so a 4xx whose prose merely contains "not
 * registered" matched the FCM-only codes and permanently deleted a live
 * subscription. Omit `kind` (the third-party/unknown-provider case) to test
 * every pattern, as before.
 */
const isGoneError = (message: string | undefined, kind?: StoredSubscription["kind"]): boolean => {
    if (message === undefined) {
        return false;
    }

    if (WEB_PUSH_GONE_PATTERN.test(message) || GONE_TEXT_FALLBACK.test(message)) {
        return true;
    }

    return kind !== "web-push" && FCM_GONE_PATTERN.test(message);
};

export { claimRefusal, fcmId, isGoneError, kindOfId, legacyFcmId, legacyIdFor, legacyWebPushId, normalizeRegisterInput, targetOf, webPushId };
