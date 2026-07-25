import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeToPush } from "../src/web";

/**
 * Encode bytes as base64url — the inverse of `web.ts`'s `urlBase64ToUint8Array`,
 * so a VAPID key we build here round-trips to the exact bytes the helper compares
 * against an existing subscription's `applicationServerKey`.
 */
const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    // base64 pads with at most two `=`; `{1,2}` avoids the unbounded `+` (sonarjs/slow-regex).
    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/={1,2}$/u, "");
};

const CURRENT_KEY_BYTES = new Uint8Array([4, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
const OLD_KEY_BYTES = new Uint8Array([4, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85]);
const VAPID_PUBLIC_KEY = toBase64Url(CURRENT_KEY_BYTES);

interface FakeSubscription {
    options: { applicationServerKey: ArrayBuffer | null };
    toJSON: () => unknown;
    unsubscribe: () => Promise<boolean>;
}

const fakeSubscription = (applicationServerKey: ArrayBuffer | null, label: string): FakeSubscription & { unsubscribed: () => boolean } => {
    let unsubscribed = false;

    return {
        options: { applicationServerKey },
        toJSON: () => {
            return { endpoint: `https://push.example/${label}`, expirationTime: null, keys: { auth: "a", p256dh: "p" } };
        },
        unsubscribe: async () => {
            unsubscribed = true;

            return true;
        },
        unsubscribed: () => unsubscribed,
    };
};

/** Wire the structural browser globals (serviceWorker + PushManager + Notification) `subscribeToPush` reads. */
const installBrowser = (existing: FakeSubscription | null): { subscribeCalls: { applicationServerKey: unknown }[] } => {
    const subscribeCalls: { applicationServerKey: unknown }[] = [];

    const pushManager = {
        getSubscription: async () => existing,
        subscribe: async (subscribeOptions: { applicationServerKey: unknown }) => {
            subscribeCalls.push(subscribeOptions);

            return fakeSubscription(null, "fresh");
        },
    };

    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager }) } });
    vi.stubGlobal("PushManager", () => {});
    vi.stubGlobal("Notification", { requestPermission: async () => "granted" });

    return { subscribeCalls };
};

describe("subscribeToPush — VAPID key rotation", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reuses an existing subscription minted with the current VAPID key", async () => {
        expect.hasAssertions();

        // A fresh copy of the current-key bytes as the stored applicationServerKey.
        const existing = fakeSubscription(new Uint8Array(CURRENT_KEY_BYTES).buffer, "existing");
        const { subscribeCalls } = installBrowser(existing);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(subscribeCalls).toHaveLength(0);
        expect(existing.unsubscribed()).toBe(false);
        expect(result).toMatchObject({ endpoint: "https://push.example/existing" });
    });

    it("unsubscribes and re-subscribes when the existing key does not match (post-rotation)", async () => {
        expect.hasAssertions();

        const existing = fakeSubscription(new Uint8Array(OLD_KEY_BYTES).buffer, "existing");
        const { subscribeCalls } = installBrowser(existing);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(existing.unsubscribed()).toBe(true);
        expect(subscribeCalls).toHaveLength(1);
        expect(result).toMatchObject({ endpoint: "https://push.example/fresh" });
    });

    it("subscribes fresh when there is no existing subscription", async () => {
        expect.hasAssertions();

        const { subscribeCalls } = installBrowser(null);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(subscribeCalls).toHaveLength(1);
        expect(result).toMatchObject({ endpoint: "https://push.example/fresh" });
    });
});
