import { describe, expect, it } from "vitest";

import { d1SubscriptionStore } from "../src/subscriptions/d1-store";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import { fcmId, isGoneError, legacyFcmId, legacyWebPushId, normalizeRegisterInput, targetOf, webPushId } from "../src/subscriptions/normalize";
import { compareById, fakeD1 } from "./helpers";

const webPushSub = { endpoint: "https://push.example/abc", keys: { auth: "AUTHKEY", p256dh: "P256KEY" } };

describe("normalizeRegisterInput", () => {
    it("normalizes a web-push subscription object", () => {
        expect.hasAssertions();

        const stored = normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 1000);

        expect(stored).toMatchObject({
            createdAt: 1000,
            endpoint: webPushSub.endpoint,
            id: webPushId(webPushSub.endpoint),
            kind: "web-push",
            lastSeenAt: 1000,
            userId: "u1",
        });
        expect(stored.keys).toStrictEqual({ auth: "AUTHKEY", p256dh: "P256KEY" });
    });

    it("parses a JSON-string web-push subscription", () => {
        expect.hasAssertions();

        const stored = normalizeRegisterInput({ subscription: JSON.stringify(webPushSub) });

        expect(stored.kind).toBe("web-push");
        expect(stored.userId).toBeNull();
    });

    it("throws on a web-push subscription missing keys", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput({ subscription: { endpoint: "https://x", keys: {} } as never })).toThrow(/keys\.\{p256dh, auth\}/u);
    });

    it("throws on invalid JSON", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput({ subscription: "{not json" })).toThrow(/not valid JSON/u);
    });

    it("normalizes an FCM token and rejects an empty one", () => {
        expect.hasAssertions();

        const stored = normalizeRegisterInput({ kind: "fcm", token: "device-token-1" });

        expect(stored).toMatchObject({ id: fcmId("device-token-1"), kind: "fcm", token: "device-token-1" });
        expect(() => normalizeRegisterInput({ kind: "fcm", token: "" })).toThrow(/non-empty `token`/u);
    });

    it("discriminates on `kind`, not on the mere presence of a `token` key", () => {
        expect.hasAssertions();

        // `RegisterInput` declares `kind` as the discriminator, but the runtime
        // branched on `"token" in input`. A web-push registration spread from an
        // object with an optional token field (`{ ...form, token: undefined }`)
        // carries the KEY, so it was routed to FCM and rejected as a missing
        // token — a registration the declared type says is valid.
        const stored = normalizeRegisterInput({ subscription: webPushSub, token: undefined }, 1000);

        expect(stored.kind).toBe("web-push");
        expect(stored.id).toBe(webPushId(webPushSub.endpoint));
    });
});

describe("normalizeRegisterInput field caps (NOTIFY-02)", () => {
    it("rejects an oversized web-push endpoint", () => {
        expect.hasAssertions();

        // `metadata` is capped because a client controls it end-to-end and it
        // lands in the row unbounded. `endpoint`, `token` and `keys` are exactly
        // as client-controlled and land in the SAME row — a 1 MB endpoint was
        // accepted while a 4 KB metadata blob was refused.
        const endpoint = `https://push.example/${"a".repeat(5000)}`;

        expect(() => normalizeRegisterInput({ subscription: { ...webPushSub, endpoint } })).toThrow(/`endpoint` is \d+ bytes/u);
    });

    it("rejects oversized web-push keys", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput({ subscription: { ...webPushSub, keys: { auth: "a".repeat(5000), p256dh: "P256KEY" } } })).toThrow(
            /`keys\.auth` is \d+ bytes/u,
        );
        expect(() => normalizeRegisterInput({ subscription: { ...webPushSub, keys: { auth: "AUTHKEY", p256dh: "p".repeat(5000) } } })).toThrow(
            /`keys\.p256dh` is \d+ bytes/u,
        );
    });

    it("rejects an oversized FCM token", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput({ kind: "fcm", token: "t".repeat(5000) })).toThrow(/`token` is \d+ bytes/u);
    });

    it("still accepts realistically-sized values", () => {
        expect.hasAssertions();

        // A real FCM registration token is ~160 chars and a real push endpoint
        // ~200; the cap must not be tight enough to refuse a live device.
        expect(() => normalizeRegisterInput({ kind: "fcm", token: "t".repeat(512) })).not.toThrow();
        expect(() => normalizeRegisterInput({ subscription: { ...webPushSub, endpoint: `https://push.example/${"a".repeat(800)}` } })).not.toThrow();
    });
});

describe("normalizeRegisterInput metadata validation (NOTIFY-02)", () => {
    it("round-trips realistic small metadata", () => {
        expect.hasAssertions();

        const metadata = { deviceName: "Pixel 9", locale: "en-US", topics: ["news", "offers"] };
        const stored = normalizeRegisterInput({ kind: "fcm", metadata, token: "device-token-1" });

        expect(stored.metadata).toStrictEqual(metadata);
    });

    it("allows omitted metadata", () => {
        expect.hasAssertions();

        const stored = normalizeRegisterInput({ kind: "fcm", token: "device-token-1" });

        expect(stored.metadata).toBeUndefined();
    });

    it("rejects a non-plain-object metadata (array, string, number)", () => {
        expect.hasAssertions();

        for (const bad of [["x"], "oops", 42, null]) {
            expect(() => normalizeRegisterInput({ kind: "fcm", metadata: bad as never, token: "t" }), JSON.stringify(bad)).toThrow(/plain object/u);
        }
    });

    it("rejects metadata exceeding the byte cap", () => {
        expect.hasAssertions();

        const metadata = { blob: "x".repeat(10_000) };

        expect(() => normalizeRegisterInput({ kind: "fcm", metadata, token: "t" })).toThrow(/exceeding the .*-byte cap/u);
    });

    it("rejects non-JSON-serialisable metadata (BigInt)", () => {
        expect.hasAssertions();

        const metadata = { amount: 10n } as unknown as Record<string, unknown>;

        expect(() => normalizeRegisterInput({ kind: "fcm", metadata, token: "t" })).toThrow(/not JSON-serialisable/u);
    });

    it("rejects a circular metadata object", () => {
        expect.hasAssertions();

        const metadata: Record<string, unknown> = { name: "loop" };

        metadata.self = metadata;

        expect(() => normalizeRegisterInput({ kind: "fcm", metadata, token: "t" })).toThrow(/not JSON-serialisable/u);
    });

    it("applies the same validation to web-push registrations", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput({ metadata: ["bad"] as never, subscription: webPushSub })).toThrow(/plain object/u);

        const stored = normalizeRegisterInput({ metadata: { locale: "de-DE" }, subscription: webPushSub });

        expect(stored.metadata).toStrictEqual({ locale: "de-DE" });
    });
});

describe("web-push endpoint SSRF validation", () => {
    const withEndpoint = (endpoint: string) => {
        return { subscription: { endpoint, keys: { auth: "AUTHKEY", p256dh: "P256KEY" } } };
    };

    it("accepts a public https endpoint", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput(withEndpoint("https://fcm.googleapis.com/fcm/send/abc"))).not.toThrow();
    });

    it("rejects a non-https (http) endpoint", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput(withEndpoint("http://push.example/abc"))).toThrow(/must use https/u);
    });

    it("rejects a non-URL endpoint", () => {
        expect.hasAssertions();

        expect(() => normalizeRegisterInput(withEndpoint("not a url"))).toThrow(/absolute https URL/u);
    });

    it("rejects private / loopback / link-local hosts", () => {
        expect.hasAssertions();

        for (const host of [
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://192.168.1.1/x",
            "https://169.254.169.254/x",
            "https://[::1]/x",
            "https://redis.internal/x",
            // 6to4 (`2002::/16`) embedding 127.0.0.1, and Teredo (`2001:0000::/32`) —
            // both tunnel an embedded IPv4 and must be blocked.
            "https://[2002:7f00:1::]/x",
            "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x",
        ]) {
            expect(() => normalizeRegisterInput(withEndpoint(host)), host).toThrow(/private\/internal address/u);
        }
    });

    it("respects allowedPushOrigins — allows a listed origin, rejects an unlisted one", () => {
        expect.hasAssertions();

        const allowedPushOrigins = ["https://fcm.googleapis.com"];

        expect(() => normalizeRegisterInput(withEndpoint("https://fcm.googleapis.com/fcm/send/abc"), undefined, { allowedPushOrigins })).not.toThrow();
        expect(() => normalizeRegisterInput(withEndpoint("https://evil.example/abc"), undefined, { allowedPushOrigins })).toThrow(
            /allowedPushOrigins allowlist/u,
        );
    });
});

describe("targetOf / ids / isGoneError", () => {
    it("produces provider targets by kind", () => {
        expect.hasAssertions();

        const wp = normalizeRegisterInput({ subscription: webPushSub });
        const fcm = normalizeRegisterInput({ kind: "fcm", token: "tok" });

        expect(JSON.parse(targetOf(wp))).toStrictEqual({ endpoint: webPushSub.endpoint, keys: webPushSub.keys });
        expect(targetOf(fcm)).toBe("tok");
    });

    it("derives deterministic ids", () => {
        expect.hasAssertions();

        expect(webPushId("https://a")).toBe(webPushId("https://a"));
        expect(webPushId("https://a")).not.toBe(webPushId("https://b"));
    });

    it("mints 64-bit, version-prefixed ids", () => {
        expect.hasAssertions();

        // 64-bit digest = 16 hex chars, behind the `wp2_`/`fcm2_` version prefix.
        expect(webPushId("https://push.example/abc")).toMatch(/^wp2_[\da-f]{16}$/u);
        expect(fcmId("device-token-1")).toMatch(/^fcm2_[\da-f]{16}$/u);

        // The EXACT digests, not just the shape. These ids are persisted primary
        // keys: if `shared/fnv1a`'s `fnv1a64Hex` ever changes, every stored
        // subscription silently re-keys — the old row goes dark and the device
        // re-registers as a duplicate. A shape-only assertion cannot see that.
        expect(webPushId("https://push.example/abc")).toBe("wp2_ebdefb71ba92d7d5");
        expect(fcmId("device-token-1")).toBe("fcm2_3d944cc157b58d75");
    });

    it("does not collide across a large synthetic-endpoint sample", () => {
        expect.hasAssertions();

        const sample = 50_000;
        const ids = new Set<string>();

        for (let index = 0; index < sample; index += 1) {
            ids.add(webPushId(`https://push.example/endpoint/${index.toString()}`));
        }

        expect(ids.size).toBe(sample);
    });

    it("prunes on structured gone signals but never on transient errors", () => {
        expect.hasAssertions();

        // Web Push structured status: HTTP 410 (Gone) / 404 (Not Found) → gone.
        expect(isGoneError("Subscription gone (HTTP 410) — remove this subscription")).toBe(true);
        expect(isGoneError("HTTP 404: Not Found")).toBe(true);
        // FCM canonical unregistered codes → gone. The FIRST of these is what the
        // `@visulima/notification` FCM provider actually emits for a dead token: it
        // forwards `body.error.message` only, and FCM HTTP v1 puts the `UNREGISTERED`
        // code in `error.details[].errorCode`, which the provider drops — so the
        // human-readable `NOT_FOUND` prose is the ONLY signal that reaches us.
        expect(isGoneError("[@visulima/notification] [fcm] Requested entity was not found.")).toBe(true);
        expect(isGoneError("NotRegistered")).toBe(true);
        expect(isGoneError("registration-token-not-registered")).toBe(true);
        // Prose fallback still prunes an explicit "subscription expired/gone".
        expect(isGoneError("The subscription is no longer valid")).toBe(true);

        // Transient failures must NOT permanently drop a valid subscription, even
        // when they contain "expired" or a status code that is not 404/410.
        expect(isGoneError("TLS certificate expired")).toBe(false);
        expect(isGoneError("session expired, retry")).toBe(false);
        expect(isGoneError("HTTP 429: Too Many Requests")).toBe(false);
        expect(isGoneError("HTTP 400: invalid token")).toBe(false);
        expect(isGoneError("503 transient upstream error")).toBe(false);
        expect(isGoneError(undefined)).toBe(false);
    });

    it("does not apply the FCM-only codes to a web-push failure", () => {
        expect.hasAssertions();

        // The web-push provider echoes the push service's response BODY into
        // `HTTP ${status}: ${body}`, so a 4xx whose prose happens to contain
        // "not registered" matched the FCM-only pattern and permanently deleted
        // a live subscription. The patterns are documented as provider-specific;
        // pass the kind so they are applied that way.
        expect(isGoneError("HTTP 403: sender not registered for this endpoint", "web-push")).toBe(false);
        expect(isGoneError("HTTP 400: UNREGISTERED sender id", "web-push")).toBe(false);

        // The FCM codes still prune an FCM device, and the shared HTTP 404/410
        // status still prunes either kind (FCM HTTP v1 answers 404 for a dead token).
        expect(isGoneError("[@visulima/notification] [fcm] Requested entity was not found.", "fcm")).toBe(true);
        expect(isGoneError("NotRegistered", "fcm")).toBe(true);
        expect(isGoneError("HTTP 404: Not Found", "fcm")).toBe(true);

        // …and the NOT_FOUND prose stays FCM-scoped: the web-push provider echoes the
        // push service's body into `HTTP ${status}: ${body}`, so a transient 5xx whose
        // prose says "not found" must not delete a live browser subscription.
        expect(isGoneError("HTTP 502: upstream route was not found", "web-push")).toBe(false);
        expect(isGoneError("HTTP 410: Gone", "web-push")).toBe(true);
    });
});

describe("memorySubscriptionStore", () => {
    it("puts, gets, lists (filtered), deletes and marks status", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        const a = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 1));
        await store.put(normalizeRegisterInput({ kind: "fcm", token: "tok", userId: "u2" }, 2));

        await expect(store.get(a.id)).resolves.toMatchObject({ id: a.id });
        await expect(store.list()).resolves.toHaveLength(2);
        await expect(store.list({ kind: "fcm" })).resolves.toHaveLength(1);
        await expect(store.list({ userId: "u1" })).resolves.toHaveLength(1);

        await store.markStatus(a.id, "failed", "boom");

        await expect(store.get(a.id)).resolves.toMatchObject({ lastError: "boom", lastStatus: "failed" });

        await store.delete(a.id);

        await expect(store.get(a.id)).resolves.toBeUndefined();
    });

    it("upsert preserves the original createdAt", async () => {
        expect.hasAssertions();

        const store = memorySubscriptionStore();
        await store.put(normalizeRegisterInput({ subscription: webPushSub }, 100));
        const again = await store.put(normalizeRegisterInput({ subscription: webPushSub }, 200));

        expect(again.createdAt).toBe(100);
        await expect(store.list()).resolves.toHaveLength(1);
    });
});

describe("d1SubscriptionStore", () => {
    it("round-trips subscriptions through the D1 slice", async () => {
        expect.hasAssertions();

        const store = d1SubscriptionStore(fakeD1());
        const wp = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 5));
        await store.put(normalizeRegisterInput({ kind: "fcm", token: "tok", userId: null }, 6));

        const read = await store.get(wp.id);

        expect(read).toMatchObject({ endpoint: webPushSub.endpoint, kind: "web-push", userId: "u1" });
        expect(read?.keys).toStrictEqual({ auth: "AUTHKEY", p256dh: "P256KEY" });

        await expect(store.list()).resolves.toHaveLength(2);
        await expect(store.list({ kind: "web-push" })).resolves.toHaveLength(1);
        await expect(store.list({ userId: null })).resolves.toHaveLength(1);

        await store.markStatus(wp.id, "ok");

        await expect(store.get(wp.id)).resolves.toMatchObject({ lastStatus: "ok" });

        await store.delete(wp.id);

        await expect(store.get(wp.id)).resolves.toBeUndefined();
    });

    it("round-trips validated metadata without the store's own JSON.stringify throwing", async () => {
        expect.hasAssertions();

        const store = d1SubscriptionStore(fakeD1());
        const metadata = { deviceName: "Pixel 9", topics: ["news"] };
        const stored = await store.put(normalizeRegisterInput({ kind: "fcm", metadata, token: "meta-tok" }));

        await expect(store.get(stored.id)).resolves.toMatchObject({ metadata });
    });

    it("rejects an unsafe table name", () => {
        expect.hasAssertions();

        expect(() => d1SubscriptionStore(fakeD1(), { tableName: "subs; DROP TABLE x" })).toThrow(/bare SQL identifier/u);
    });

    it("read-back honors a limit filter (LIMIT is applied server-side)", async () => {
        expect.hasAssertions();

        const store = d1SubscriptionStore(fakeD1());

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await store.put(
                normalizeRegisterInput({ subscription: { endpoint: `https://push.example/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } }),
            );
        }

        await expect(store.list()).resolves.toHaveLength(5);
        await expect(store.list({ limit: 2 })).resolves.toHaveLength(2);
    });
});

describe("legacy-id migration eviction (memory + D1)", () => {
    const stores: ReadonlyArray<readonly [string, () => ReturnType<typeof memorySubscriptionStore>]> = [
        ["memory", () => memorySubscriptionStore()],
        ["d1", () => d1SubscriptionStore(fakeD1())],
    ];

    it.each(stores)("a canonical web-push put removes the pre-existing legacy `wp_` row for the same identity (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const { endpoint } = webPushSub;

        // Seed the legacy 32-bit `wp_` row as an older client would have left it — a
        // different PK from the new `wp2_` id, so `ON CONFLICT(id)` never touches it.
        const legacyId = legacyWebPushId(endpoint);

        await store.put({ createdAt: 1, endpoint, id: legacyId, keys: webPushSub.keys, kind: "web-push", lastSeenAt: 1, userId: "u1" });

        await expect(store.get(legacyId)).resolves.toBeDefined();

        // Re-register the SAME endpoint under the new 64-bit `wp2_` id.
        const current = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 2));

        expect(current.id).toBe(webPushId(endpoint));
        expect(current.id).not.toBe(legacyId);
        // The legacy row is evicted → only ONE row survives, so a `broadcast` (no id
        // filter, lists all) delivers to this device exactly once, not twice.
        await expect(store.get(legacyId)).resolves.toBeUndefined();
        await expect(store.list()).resolves.toHaveLength(1);
    });

    it.each(stores)("still evicts an UNOWNED legacy row when the device signs in (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        // The eviction's owner predicate is the CLAIM one, not `deleteOwned`'s
        // exact match: a device registered anonymously under the old scheme and
        // re-registered by a signed-in user must still lose its legacy row, or the
        // migration leaves two rows and `broadcast` delivers to it twice forever.
        const store = makeStore();
        const { endpoint } = webPushSub;
        const legacyId = legacyWebPushId(endpoint);

        await store.put({ createdAt: 1, endpoint, id: legacyId, keys: webPushSub.keys, kind: "web-push", lastSeenAt: 1, userId: null });

        await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 2));

        await expect(store.get(legacyId)).resolves.toBeUndefined();
        await expect(store.list()).resolves.toHaveLength(1);
    });

    it.each(stores)("also evicts the legacy `fcm_` row for a re-registered token (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const token = "device-token-legacy";
        const legacyId = legacyFcmId(token);

        await store.put({ createdAt: 1, id: legacyId, kind: "fcm", lastSeenAt: 1, token, userId: "u2" });

        const current = await store.put(normalizeRegisterInput({ kind: "fcm", token, userId: "u2" }, 2));

        expect(current.id).toBe(fcmId(token));
        await expect(store.get(legacyId)).resolves.toBeUndefined();
        await expect(store.list()).resolves.toHaveLength(1);
    });
});

describe("keyset pagination via `after` (memory + D1 parity)", () => {
    const stores: ReadonlyArray<readonly [string, () => ReturnType<typeof memorySubscriptionStore>]> = [
        ["memory", () => memorySubscriptionStore()],
        ["d1", () => d1SubscriptionStore(fakeD1())],
    ];

    it.each(stores)("orders ascending by id and pages with an exclusive cursor (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();

        for (let index = 0; index < 10; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await store.put(
                normalizeRegisterInput({ subscription: { endpoint: `https://push.example/page/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } }),
            );
        }

        const all = await store.list();

        expect(all).toHaveLength(10);

        const expectedIds = all.toSorted(compareById).map((s) => s.id);

        // Walk the whole store in pages of 3, an exclusive `after` cursor each time.
        const seen: string[] = [];
        let cursor: string | undefined;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential in this walk
            const page = await store.list({ after: cursor, limit: 3 });

            if (page.length === 0) {
                break;
            }

            // Ascending order within the page.
            for (let index = 1; index < page.length; index += 1) {
                const previousId = page[index - 1]?.id as string;
                const currentId = page[index]?.id as string;

                // eslint-disable-next-line vitest/prefer-comparison-matcher -- `toBeGreaterThan` is typed number|bigint only; these are string ids
                expect(currentId > previousId).toBe(true);
            }

            seen.push(...page.map((s) => s.id));
            cursor = page[page.length - 1]?.id;

            if (page.length < 3) {
                break;
            }
        }

        // Every row visited exactly once, in ascending id order overall — no
        // skip and no double-delivery across the page boundary.
        expect(seen).toStrictEqual(expectedIds);
    });

    it.each(stores)("a cursor is exclusive — the boundary row is not repeated (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();

        for (let index = 0; index < 4; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            await store.put(
                normalizeRegisterInput({ subscription: { endpoint: `https://push.example/excl/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } }),
            );
        }

        const firstPage = await store.list({ limit: 2 });
        const boundary = firstPage[1]?.id as string;
        const secondPage = await store.list({ after: boundary, limit: 2 });

        expect(secondPage.map((s) => s.id)).not.toContain(boundary);
        expect(secondPage.every((s) => s.id > boundary)).toBe(true);
    });

    it.each(stores)("stays stable under a concurrent register mid-walk — the already-consumed page is unaffected (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const originalIds: string[] = [];

        for (let index = 0; index < 3; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential registration in a test
            const stored = await store.put(
                normalizeRegisterInput({ subscription: { endpoint: `https://push.example/concurrent/${index.toString()}`, keys: { auth: "a", p256dh: "p" } } }),
            );

            originalIds.push(stored.id);
        }

        const firstPage = await store.list({ limit: 2 });

        expect(firstPage).toHaveLength(2);

        // A new device registers BETWEEN the first and second page fetch — must
        // not retroactively appear in a page already walked (firstPage is fixed,
        // already returned), nor cause an already-seen row to be skipped or
        // repeated in the next page. Whether the NEW device itself lands before
        // or after the cursor depends on its id's hash position — both are
        // correct keyset-pagination outcomes, so this only asserts what's
        // deterministic: the 3 PRE-EXISTING ids are exactly accounted for once
        // each, and the new device never causes a duplicate/skip among them.
        await store.put(normalizeRegisterInput({ subscription: { endpoint: "https://push.example/concurrent/new", keys: { auth: "a", p256dh: "p" } } }));

        const cursor = firstPage[1]?.id as string;
        const secondPage = await store.list({ after: cursor, limit: 10 });

        const firstIds = new Set(firstPage.map((s) => s.id));

        for (const subscription of secondPage) {
            // Exclusive cursor: nothing already returned in firstPage reappears.
            expect(firstIds.has(subscription.id)).toBe(false);
            // eslint-disable-next-line vitest/prefer-comparison-matcher -- `toBeGreaterThan` is typed number|bigint only; these are string ids
            expect(subscription.id > cursor).toBe(true);
        }

        // Every pre-existing id appears in exactly one of the two pages — the
        // cursor boundary is exclusive and stable regardless of the concurrent
        // register (the 3rd pre-existing id, being the largest of the original
        // 3, is guaranteed > cursor and so always surfaces in secondPage).
        const combinedIds = new Set([...firstPage.map((s) => s.id), ...secondPage.map((s) => s.id)]);

        for (const id of originalIds) {
            expect(combinedIds.has(id)).toBe(true);
        }
    });
});

describe("re-register status parity (memory + D1)", () => {
    const stores: ReadonlyArray<readonly [string, () => ReturnType<typeof memorySubscriptionStore>]> = [
        ["memory", () => memorySubscriptionStore()],
        ["d1", () => d1SubscriptionStore(fakeD1())],
    ];

    it.each(stores)("preserves lastStatus/lastError and the original createdAt on re-register (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const first = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 100));

        // A prior delivery recorded a status; a routine re-register (no status) must
        // NOT wipe it, and the returned row must carry the truthful first-seen time.
        await store.markStatus(first.id, "failed", "boom");

        const again = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 200));

        expect(again.createdAt).toBe(100);
        expect(again.lastStatus).toBe("failed");
        expect(again.lastError).toBe("boom");
    });
});

describe("put ownership parity (memory + D1)", () => {
    const stores: ReadonlyArray<readonly [string, () => ReturnType<typeof memorySubscriptionStore>]> = [
        ["memory", () => memorySubscriptionStore()],
        ["d1", () => d1SubscriptionStore(fakeD1())],
    ];

    it.each(stores)("refuses to move a row to a different owner (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const owned = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "victim" }, 100));

        await expect(store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "attacker" }, 200))).rejects.toThrow(
            /registered to a different user/u,
        );

        // Refused means UNCHANGED, not partially applied: the owner, the delivery
        // keys and the first-seen time all still describe the victim's device.
        await expect(store.get(owned.id)).resolves.toMatchObject({ createdAt: 100, keys: webPushSub.keys, userId: "victim" });
    });

    it.each(stores)("refuses an anonymous put over an owned row (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();

        await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 100));

        await expect(store.put(normalizeRegisterInput({ subscription: webPushSub }, 200))).rejects.toThrow(/registered to a different user/u);
    });

    it.each(stores)("still claims an unowned row and still upserts for the same owner (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        const store = makeStore();
        const anonymous = await store.put(normalizeRegisterInput({ subscription: webPushSub }, 100));

        const claimed = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 200));

        expect(claimed.userId).toBe("u1");

        const refreshed = await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "u1" }, 300));

        expect(refreshed).toMatchObject({ createdAt: 100, id: anonymous.id, userId: "u1" });
    });

    it.each(stores)("does not evict a legacy-id row belonging to someone else (%s)", async (_name, makeStore) => {
        expect.hasAssertions();

        // The legacy row has its own primary key, so the guarded upsert cannot
        // reach it — the migration eviction is a separate DELETE, and unscoped it
        // silences the victim's device exactly as a re-own would.
        const store = makeStore();
        const legacyId = legacyWebPushId(webPushSub.endpoint);

        await store.put({
            createdAt: 1,
            endpoint: webPushSub.endpoint,
            id: legacyId,
            keys: webPushSub.keys,
            kind: "web-push",
            lastSeenAt: 1,
            userId: "victim",
        });

        await store.put(normalizeRegisterInput({ subscription: webPushSub, userId: "attacker" }, 200));

        await expect(store.get(legacyId)).resolves.toMatchObject({ userId: "victim" });
    });
});
