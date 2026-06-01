import { describe, expect, test } from "vitest";

import { createReconnect } from "../src/reconnect.js";

describe("createReconnect", () => {
    test("doubles delay each attempt without jitter", () => {
        expect.assertions(4);

        const reconnect = createReconnect({ initialDelayMs: 100, maxDelayMs: 10_000, jitter: false });

        expect(reconnect.next()).toBe(100);
        expect(reconnect.next()).toBe(200);
        expect(reconnect.next()).toBe(400);
        expect(reconnect.next()).toBe(800);
    });

    test("caps at maxDelayMs", () => {
        expect.assertions(4);

        const reconnect = createReconnect({ initialDelayMs: 1000, maxDelayMs: 3000, jitter: false });

        expect(reconnect.next()).toBe(1000);
        expect(reconnect.next()).toBe(2000);
        expect(reconnect.next()).toBe(3000);
        expect(reconnect.next()).toBe(3000);
    });

    test("reset() returns to initial delay", () => {
        expect.assertions(1);

        const reconnect = createReconnect({ initialDelayMs: 50, maxDelayMs: 5000, jitter: false });

        reconnect.next();
        reconnect.next();
        reconnect.reset();

        expect(reconnect.next()).toBe(50);
    });

    test("jittered delay stays within [delay/2, delay]", () => {
        expect.assertions(2);

        const reconnect = createReconnect({ initialDelayMs: 1000, maxDelayMs: 10_000, jitter: true }, () => 0.5);

        const first = reconnect.next();

        expect(first).toBeGreaterThanOrEqual(500);
        expect(first).toBeLessThanOrEqual(1000);
    });

    test("uses defaults when not configured", () => {
        expect.assertions(2);

        const reconnect = createReconnect({});

        const value = reconnect.next();

        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(250);
    });
});
