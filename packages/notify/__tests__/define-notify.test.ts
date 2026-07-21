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

    it("rejects non-definition values in the brand guard", () => {
        expect.hasAssertions();

        expect(isNotifyDefinition(null)).toBe(false);
        expect(isNotifyDefinition({})).toBe(false);
        expect(isNotifyDefinition({ isLunoraNotify: false })).toBe(false);
    });
});
