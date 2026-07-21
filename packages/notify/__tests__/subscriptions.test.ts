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

    it("recognizes gone signals", () => {
        expect.hasAssertions();

        expect(isGoneError("410 Gone")).toBe(true);
        expect(isGoneError("FCM UNREGISTERED")).toBe(true);
        expect(isGoneError("404 not found")).toBe(true);
        expect(isGoneError("503 transient")).toBe(false);
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
