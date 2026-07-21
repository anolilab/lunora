/**
 * `@lunora/notify/web` — the browser-side helper for registering a service-worker
 * Web Push subscription. Runs in the browser (Push API + `navigator.serviceWorker`),
 * has no server imports, and returns a plain, JSON-serialisable subscription you
 * hand to a Lunora mutation calling `ctx.push.register({ subscription, userId })`.
 *
 * ```ts
 * import { subscribeToPush } from "@lunora/notify/web";
 *
 * const subscription = await subscribeToPush({ serviceWorkerUrl: "/sw.js", vapidPublicKey });
 * await client.mutation("registerDevice", { subscription });
 * ```
 * @packageDocumentation
 */

/** A plain, JSON-serialisable Web Push subscription (the shape `ctx.push.register` accepts). */
interface SerializedPushSubscription {
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
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
const urlBase64ToUint8Array = (base64: string): Uint8Array => {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replaceAll("-", "+").replaceAll("_", "/");
    const raw = atob(normalized);
    const output = new Uint8Array(raw.length);

    for (let index = 0; index < raw.length; index += 1) {
        output[index] = raw.codePointAt(index) ?? 0;
    }

    return output;
};

/** A loose view of the browser globals, so support detection reads them without type-narrowing lint. */
const browserGlobals = globalThis as { navigator?: { serviceWorker?: unknown }; PushManager?: unknown };

/** Whether the current browser supports the Web Push flow (service workers + Push API). */
const isPushSupported = (): boolean => browserGlobals.navigator?.serviceWorker !== undefined && browserGlobals.PushManager !== undefined;

/**
 * Register (or reuse) a service worker and subscribe the browser to Web Push,
 * returning the subscription in serialisable form. Reuses an existing subscription
 * when present. Throws if push is unsupported or the user denies permission.
 */
const subscribeToPush = async (options: SubscribeToPushOptions): Promise<SerializedPushSubscription> => {
    if (!isPushSupported()) {
        throw new Error("@lunora/notify: Web Push is not supported in this browser (needs service workers + PushManager)");
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

    const existing = await registration.pushManager.getSubscription();
    const subscription =
        existing ??
        (await registration.pushManager.subscribe({
            applicationServerKey: urlBase64ToUint8Array(options.vapidPublicKey) as BufferSource,
            userVisibleOnly: true,
        }));

    return subscription.toJSON() as SerializedPushSubscription;
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

export type { SerializedPushSubscription, SubscribeToPushOptions };
export { isPushSupported, subscribeToPush, unsubscribeFromPush };
