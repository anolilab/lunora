import { describe, expect, it } from "vitest";

import { createReconnect } from "../src/reconnect.js";

describe("createReconnect", () => {
    it("doubles delay each attempt without jitter", () => {
        expect.assertions(4);

        const reconnect = createReconnect({ initialDelayMs: 100, jitter: false, maxDelayMs: 10_000 });

        expect(reconnect.next()).toBe(100);
        expect(reconnect.next()).toBe(200);
        expect(reconnect.next()).toBe(400);
        expect(reconnect.next()).toBe(800);
    });

    it("caps at maxDelayMs", () => {
        expect.assertions(4);

        const reconnect = createReconnect({ initialDelayMs: 1000, jitter: false, maxDelayMs: 3000 });

        expect(reconnect.next()).toBe(1000);
        expect(reconnect.next()).toBe(2000);
        expect(reconnect.next()).toBe(3000);
        expect(reconnect.next()).toBe(3000);
    });

    it("reset() returns to initial delay", () => {
        expect.assertions(1);

        const reconnect = createReconnect({ initialDelayMs: 50, jitter: false, maxDelayMs: 5000 });

        reconnect.next();
        reconnect.next();
        reconnect.reset();

        expect(reconnect.next()).toBe(50);
    });

    it("jittered delay stays within [delay/2, delay]", () => {
        expect.assertions(2);

        const reconnect = createReconnect({ initialDelayMs: 1000, jitter: true, maxDelayMs: 10_000 }, () => 0.5);

        const first = reconnect.next();

        expect(first).toBeGreaterThanOrEqual(500);
        expect(first).toBeLessThanOrEqual(1000);
    });

    it("uses defaults when not configured", () => {
        expect.assertions(2);

        const reconnect = createReconnect({});

        const value = reconnect.next();

        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(250);
    });
});
