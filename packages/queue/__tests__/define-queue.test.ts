import { describe, expect, it } from "vitest";

import { defineQueue, isQueueDefinition, queueBindingName, queueDefaultName } from "../src/define-queue";

describe("defineQueue", () => {
    it("brands a push definition and defaults the mode", () => {
        expect.assertions(3);

        const definition = defineQueue({ handler: () => {} });

        expect(definition.isLunoraQueue).toBe(true);
        expect(definition.mode).toBe("push");
        expect(isQueueDefinition(definition)).toBe(true);
    });

    it("allows a pull consumer without a handler", () => {
        expect.assertions(2);

        const definition = defineQueue({ mode: "pull" });

        expect(definition.mode).toBe("pull");
        expect(definition.handler).toBeUndefined();
    });

    it("requires a handler for a push consumer", () => {
        expect.assertions(1);

        expect(() => defineQueue({})).toThrow(/handler/);
    });

    it("rejects an unknown mode", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard against bad JS callers
        expect(() => defineQueue({ handler: () => {}, mode: "broadcast" })).toThrow(/mode/);
    });

    it("rejects an empty name override", () => {
        expect.assertions(1);

        expect(() => defineQueue({ handler: () => {}, name: "" })).toThrow(/name/);
    });

    it("is not a queue definition for arbitrary values", () => {
        expect.assertions(3);

        expect(isQueueDefinition({})).toBe(false);
        expect(isQueueDefinition(null)).toBe(false);
        expect(isQueueDefinition("queue")).toBe(false);
    });
});

describe("naming helpers", () => {
    it("derives the producer binding name", () => {
        expect.assertions(3);

        expect(queueBindingName("email")).toBe("QUEUE_EMAIL");
        expect(queueBindingName("emailQueue")).toBe("QUEUE_EMAIL_QUEUE");
        expect(queueBindingName("sendWelcomeEmail")).toBe("QUEUE_SEND_WELCOME_EMAIL");
    });

    it("derives the stable wrangler queue name", () => {
        expect.assertions(3);

        expect(queueDefaultName("email")).toBe("email");
        expect(queueDefaultName("emailQueue")).toBe("email-queue");
        expect(queueDefaultName("sendWelcomeEmail")).toBe("send-welcome-email");
    });
});
