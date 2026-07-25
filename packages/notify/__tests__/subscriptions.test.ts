import { describe, expect, it } from "vitest";

import { d1SubscriptionStore } from "../src/subscriptions/d1-store";
import { memorySubscriptionStore } from "../src/subscriptions/memory-store";
import { fcmId, isGoneError, normalizeRegisterInput, targetOf, webPushId } from "../src/subscriptions/normalize";
import { fakeD1 } from "./helpers";

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
        // FCM canonical unregistered codes → gone.
        expect(isGoneError("FCM push failed: UNREGISTERED")).toBe(true);
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

    it("rejects an unsafe table name", () => {
        expect.hasAssertions();

        expect(() => d1SubscriptionStore(fakeD1(), { tableName: "subs; DROP TABLE x" })).toThrow(/bare SQL identifier/u);
    });
});
