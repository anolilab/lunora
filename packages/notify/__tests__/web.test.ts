import { afterEach, describe, expect, it, vi } from "vitest";

import { isPushSupported, subscribeToPush } from "../src/web";

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
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer | null };
    toJSON: () => unknown;
    unsubscribe: () => Promise<boolean>;
}

const fakeSubscription = (applicationServerKey: ArrayBuffer | null, label: string): FakeSubscription & { unsubscribed: () => boolean } => {
    let unsubscribed = false;

    return {
        endpoint: `https://push.example/${label}`,
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
        expect(result.subscription).toMatchObject({ endpoint: "https://push.example/existing" });
    });

    it("unsubscribes and re-subscribes when the existing key does not match (post-rotation)", async () => {
        expect.hasAssertions();

        const existing = fakeSubscription(new Uint8Array(OLD_KEY_BYTES).buffer, "existing");
        const { subscribeCalls } = installBrowser(existing);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(existing.unsubscribed()).toBe(true);
        expect(subscribeCalls).toHaveLength(1);
        expect(result.subscription).toMatchObject({ endpoint: "https://push.example/fresh" });
    });

    it("subscribes fresh when there is no existing subscription", async () => {
        expect.hasAssertions();

        const { subscribeCalls } = installBrowser(null);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(subscribeCalls).toHaveLength(1);
        expect(result.subscription).toMatchObject({ endpoint: "https://push.example/fresh" });
        expect(result.replacedEndpoint).toBeUndefined();
    });

    it("reports the replaced endpoint so the orphaned server row can be unregistered", async () => {
        expect.hasAssertions();

        // The rotation drops the old browser subscription but mints a NEW
        // endpoint, hence a new `webPushId`, so the old row is never upserted
        // over. `403 VapidPkHashMismatch` is correctly not a "gone" signal, so
        // it is never pruned either — every later broadcast pays a POST and a
        // write for that orphan forever. Handing the old endpoint back is what
        // lets the caller unregister it (`ctx.push.unregister(webPushId(e))`).
        const existing = fakeSubscription(new Uint8Array(OLD_KEY_BYTES).buffer, "existing");

        installBrowser(existing);

        const result = await subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY });

        expect(result.replacedEndpoint).toBe("https://push.example/existing");
        expect(result.subscription).toMatchObject({ endpoint: "https://push.example/fresh" });
    });

    it("reports Web Push as unsupported when `Notification` is missing", async () => {
        expect.hasAssertions();

        // Support detection covered service workers + PushManager but not
        // `Notification`, which `subscribeToPush` then calls unguarded — so a
        // browser without it got a bare `ReferenceError` instead of the
        // documented "not supported" error.
        installBrowser(null);
        vi.stubGlobal("Notification", undefined);

        expect(isPushSupported()).toBe(false);
        await expect(subscribeToPush({ vapidPublicKey: VAPID_PUBLIC_KEY })).rejects.toThrow(/not supported in this browser/u);
    });
});

/**
 * The base64url decode helper is private, exercised here through
 * `subscribeToPush`'s key-match reuse path: a subscription minted with key bytes
 * `K` is reused only when `decode(encode(K))` byte-equals `K`, so reuse (no
 * re-subscribe) proves the base64url decode round-tripped for that key. We span
 * every achievable padding length and force the `-`/`_` → `+`/`/` substitution.
 */
describe("subscribeToPush — base64url key decoding (padding lengths + substitution)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /**
     * Build `byteLength` bytes that begin with `0xFB, 0xF0` — the pair whose
     * base64 encoding is `+/…`, i.e. `-_…` in base64url — so every crafted key
     * contains BOTH base64url-only characters and the substitution branch runs.
     */
    const keyBytes = (byteLength: number): Uint8Array => {
        const bytes = new Uint8Array(byteLength);

        bytes[0] = 0xfb;
        bytes[1] = 0xf0;

        for (let index = 2; index < byteLength; index += 1) {
            bytes[index] = (index * 37) % 256;
        }

        return bytes;
    };

    /**
     * Assert that a subscription minted with `bytes` is reused (the decode of its
     * base64url encoding byte-equals the original) — after asserting the encoding
     * has the expected `length % 4` residue and carries the `-`/`_` substitution.
     */
    const expectReuseForKey = async (bytes: Uint8Array, lengthMod4: number): Promise<void> => {
        const encoded = toBase64Url(bytes);

        expect(encoded.length % 4).toBe(lengthMod4);
        expect(encoded).toMatch(/[-_]/u);

        const existing = fakeSubscription(new Uint8Array(bytes).buffer, "existing");
        const { subscribeCalls } = installBrowser(existing);

        const result = await subscribeToPush({ vapidPublicKey: encoded });

        // Reused: the round-trip decode matched, so no new subscription was minted.
        expect(subscribeCalls).toHaveLength(0);
        expect(existing.unsubscribed()).toBe(false);
        expect(result.subscription).toMatchObject({ endpoint: "https://push.example/existing" });
    };

    // base64url strips `=` padding, so the stripped length is only ever
    // `len % 4 ∈ {0, 2, 3}` (padding of 0, 2, 1 chars respectively); `len % 4 === 1`
    // is unreachable for valid base64. One key per achievable residue:

    it("decodes a key with no stripped padding (byteLength % 3 === 0 → len % 4 === 0)", async () => {
        expect.hasAssertions();

        // 15 bytes → base64url length 20 (len % 4 === 0, zero padding added on decode).
        await expectReuseForKey(keyBytes(15), 0);
    });

    it("decodes a key needing two padding chars (byteLength % 3 === 1 → len % 4 === 2)", async () => {
        expect.hasAssertions();

        // 16 bytes → base64url length 22 (len % 4 === 2, two `=` added on decode).
        await expectReuseForKey(keyBytes(16), 2);
    });

    it("decodes a key needing one padding char (byteLength % 3 === 2 → len % 4 === 3)", async () => {
        expect.hasAssertions();

        // 17 bytes → base64url length 23 (len % 4 === 3, one `=` added on decode).
        await expectReuseForKey(keyBytes(17), 3);
    });
});
