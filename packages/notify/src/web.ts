/**
 * `@lunora/notify/web` — the browser-side helper for registering a service-worker
 * Web Push subscription. Runs in the browser (Push API + `navigator.serviceWorker`),
 * has no server imports, and returns a plain, JSON-serialisable subscription you
 * hand to a Lunora mutation calling `ctx.push.register({ subscription, userId })`.
 *
 * ```ts
 * import { subscribeToPush } from "@lunora/notify/web";
 *
 * const { replacedEndpoint, subscription } = await subscribeToPush({ serviceWorkerUrl: "/sw.js", vapidPublicKey });
 * // `replacedEndpoint` is set after a VAPID rotation — pass it on so the server
 * // can drop the stale row (`ctx.push.unregister(webPushId(replacedEndpoint), { userId: ctx.auth?.userId })`).
 * await client.mutation("registerDevice", { replacedEndpoint, subscription });
 * ```
 * @packageDocumentation
 */

/** A plain, JSON-serialisable Web Push subscription (the shape `ctx.push.register` accepts). */
import { fromBase64Url } from "../../../shared/base64";

interface SerializedPushSubscription {
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
}

/**
 * What {@link subscribeToPush} returns: the (new or reused) subscription, plus
 * the endpoint of the one it replaced, when it replaced one.
 */
interface SubscribeToPushResult {
    /**
     * The endpoint of the subscription this call dropped — set ONLY on the
     * VAPID-rotation path, where the stale subscription is unsubscribed and a
     * new one minted under the current key.
     *
     * Send it to the server and unregister it — owner-scoped, since this is a
     * caller-supplied key
     * (`ctx.push.unregister(webPushId(replacedEndpoint), { userId: ctx.auth?.userId })`). The new subscription
     * carries a NEW endpoint, hence a new store id, so it never upserts over the
     * old row — and `403 VapidPkHashMismatch`, which every send to that row now
     * answers, is correctly not a "gone" signal, so nothing prunes it either.
     * Dropped instead of returned, the row is billed a POST and a write on every
     * later broadcast, forever.
     */
    replacedEndpoint?: string;

    /** The active subscription, in the serialisable shape `ctx.push.register` accepts. */
    subscription: SerializedPushSubscription;
}

/** Options for {@link subscribeToPush}. */
interface SubscribeToPushOptions {
    /**
     * Service-worker registration scope (passed to `register`). Only used when
     * `serviceWorkerUrl` is provided.
     */
    scope?: string;

    /**
     * URL of the service worker script to register. Omit to reuse the page's
     * already-active registration (`navigator.serviceWorker.ready`).
     */
    serviceWorkerUrl?: string;

    /**
     * The application server VAPID **public** key (base64url) — must match the
     * `VAPID_PUBLIC_KEY` the server signs with. Required for a new subscription.
     */
    vapidPublicKey: string;
}

/** Convert a base64url string to the `Uint8Array` `pushManager.subscribe` wants for `applicationServerKey`. */
const urlBase64ToUint8Array = (base64: string): Uint8Array => fromBase64Url(base64);

/** Byte-for-byte equality of two `Uint8Array`s (VAPID application-server keys). */
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Whether an existing browser subscription was created with the CURRENT VAPID
 * public key. After a VAPID key rotation the cached subscription still carries the
 * OLD `applicationServerKey`, and the push service rejects every send to it with
 * `403 VapidPkHashMismatch` forever (correctly not pruned as gone, so it sticks).
 * Comparing the stored key to the current one lets {@link subscribeToPush} drop the
 * stale subscription and re-subscribe. A subscription with no recorded key is
 * treated as a mismatch (fail-safe → re-subscribe under the known-current key).
 */
const matchesVapidKey = (existing: PushSubscription, vapidPublicKey: string): boolean => {
    const stored = existing.options.applicationServerKey;

    if (stored === null) {
        return false;
    }

    return bytesEqual(new Uint8Array(stored), urlBase64ToUint8Array(vapidPublicKey));
};

/** A loose view of the browser globals, so support detection reads them without type-narrowing lint. */
const browserGlobals = globalThis as { navigator?: { serviceWorker?: unknown }; Notification?: unknown; PushManager?: unknown };

/**
 * Whether the current browser supports the Web Push flow (service workers +
 * Push API + the Notifications API). `Notification` is part of the check because
 * {@link subscribeToPush} calls `Notification.requestPermission()` — without it
 * a browser missing the API got a bare `ReferenceError` rather than the
 * "not supported" error this predicate exists to produce.
 */
const isPushSupported = (): boolean =>
    browserGlobals.navigator?.serviceWorker !== undefined && browserGlobals.PushManager !== undefined && browserGlobals.Notification !== undefined;

/**
 * Register (or reuse) a service worker and subscribe the browser to Web Push,
 * returning the subscription in serialisable form. Reuses an existing subscription
 * when present. Throws if push is unsupported or the user denies permission.
 */
const subscribeToPush = async (options: SubscribeToPushOptions): Promise<SubscribeToPushResult> => {
    if (!isPushSupported()) {
        throw new Error("@lunora/notify: Web Push is not supported in this browser (needs service workers + PushManager + Notification)");
    }

    let registration: ServiceWorkerRegistration;

    if (options.serviceWorkerUrl === undefined) {
        registration = await navigator.serviceWorker.ready;
    } else {
        const registerOptions = options.scope === undefined ? undefined : { scope: options.scope };

        registration = await navigator.serviceWorker.register(options.serviceWorkerUrl, registerOptions);
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
        throw new Error(`@lunora/notify: notification permission was not granted (got "${permission}")`);
    }

    // Reuse an existing subscription only when it was minted with the CURRENT VAPID
    // key. After a key rotation a cached subscription carries the old
    // `applicationServerKey` and every send to it fails with `403
    // VapidPkHashMismatch` forever — so drop the stale one and re-subscribe.
    const existing = await registration.pushManager.getSubscription();
    let reusable: null | PushSubscription = null;
    let replacedEndpoint: string | undefined;

    if (existing !== null) {
        if (matchesVapidKey(existing, options.vapidPublicKey)) {
            reusable = existing;
        } else {
            // Read the endpoint BEFORE unsubscribing: it is the only handle on
            // the server row this rotation orphans — see the result type's
            // `replacedEndpoint` field for why nothing else ever clears it.
            replacedEndpoint = existing.endpoint;
            await existing.unsubscribe();
        }
    }

    const subscription =
        reusable ??
        (await registration.pushManager.subscribe({
            applicationServerKey: urlBase64ToUint8Array(options.vapidPublicKey) as BufferSource,
            userVisibleOnly: true,
        }));

    return { replacedEndpoint, subscription: subscription.toJSON() as SerializedPushSubscription };
};

/** Unsubscribe the browser's current Web Push subscription. Returns whether one was removed. */
const unsubscribeFromPush = async (): Promise<boolean> => {
    if (!isPushSupported()) {
        return false;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    return subscription === null ? false : subscription.unsubscribe();
};

export type { SerializedPushSubscription, SubscribeToPushOptions, SubscribeToPushResult };
export { isPushSupported, subscribeToPush, unsubscribeFromPush };
