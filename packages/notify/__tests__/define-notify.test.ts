import { describe, expect, it } from "vitest";

import { defineNotify, isNotifyDefinition } from "../src/define-notify";

describe("defineNotify", () => {
    it("brands a valid config", () => {
        expect.hasAssertions();

        const definition = defineNotify({ webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "mailto:a@b.c" } });

        expect(definition.isLunoraNotify).toBe(true);
        expect(isNotifyDefinition(definition)).toBe(true);
    });

    it("accepts factory forms for webPush/fcm", () => {
        expect.hasAssertions();

        const definition = defineNotify({
            fcm: () => {
                return { accessToken: "t", projectId: "p" };
            },
            webPush: () => undefined,
        });

        expect(isNotifyDefinition(definition)).toBe(true);
    });

    it("throws when no push channel is configured", () => {
        expect.hasAssertions();

        expect(() => defineNotify({})).toThrow(/at least one push channel/u);
    });

    it("throws when store is not a function", () => {
        expect.hasAssertions();

        // @ts-expect-error — invalid store type
        expect(() => defineNotify({ store: {}, webPush: { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" } })).toThrow(
            /`store` must be a function/u,
        );
    });

    it("rejects a non-positive-integer broadcastPageSize / concurrency", () => {
        expect.hasAssertions();

        const webPush = { vapidPrivateKey: "d", vapidPublicKey: "p", vapidSubject: "s" };

        // `Math.max(1, NaN)` is NaN, which would page a broadcast zero rows
        // forever — reject where the app can see it instead.
        expect(() => defineNotify({ broadcastPageSize: Number.NaN, webPush })).toThrow(/`broadcastPageSize` must be a positive integer/u);
        expect(() => defineNotify({ broadcastPageSize: 0, webPush })).toThrow(/`broadcastPageSize` must be a positive integer/u);
        expect(() => defineNotify({ concurrency: -1, webPush })).toThrow(/`concurrency` must be a positive integer/u);
        expect(defineNotify({ broadcastPageSize: 500, concurrency: 4, webPush }).broadcastPageSize).toBe(500);
    });

    it("rejects non-definition values in the brand guard", () => {
        expect.hasAssertions();

        expect(isNotifyDefinition(null)).toBe(false);
        expect(isNotifyDefinition({})).toBe(false);
        expect(isNotifyDefinition({ isLunoraNotify: false })).toBe(false);
    });
});
