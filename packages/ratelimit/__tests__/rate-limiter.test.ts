import { describe, expect, test } from "vitest";

import { RateLimitError } from "../src/error.js";
import { RateLimiter } from "../src/rate-limiter.js";
import type { RateLimitConfigMap } from "../src/types.js";

const config = {
    login: { kind: "fixed window", period: 1000, rate: 3 },
    poll: { kind: "sliding window", period: 1000, rate: 4 },
    send: { kind: "token bucket", period: 1000, rate: 5 },
} satisfies RateLimitConfigMap<"login" | "poll" | "send">;

const makeLimiter = (overrides: { clock?: { now: number }; denyList?: string[] } = {}) => {
    const clock = overrides.clock ?? { now: 0 };

    return new RateLimiter({ config, denyList: overrides.denyList, now: () => clock.now });
};

describe("limit", () => {
    test("consumes capacity and then rejects", async () => {
        const limiter = makeLimiter();

        for (let index = 0; index < 5; index += 1) {
            await expect(limiter.limit("send")).resolves.toMatchObject({ ok: true });
        }

        await expect(limiter.limit("send")).resolves.toMatchObject({ ok: false, reason: "rate" });
    });

    test("isolates separate keys", async () => {
        const limiter = makeLimiter();

        for (let index = 0; index < 5; index += 1) {
            await limiter.limit("send", { key: "alice" });
        }

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: false });
        // Bob's bucket is untouched.
        await expect(limiter.limit("send", { key: "bob" })).resolves.toMatchObject({ ok: true });
    });

    test("count consumes multiple units at once", async () => {
        const limiter = makeLimiter();

        await expect(limiter.limit("send", { count: 5 })).resolves.toMatchObject({ ok: true });
        await expect(limiter.limit("send", { count: 1 })).resolves.toMatchObject({ ok: false });
    });

    test("throws RateLimitError when throws is set", async () => {
        const limiter = makeLimiter();

        await limiter.limit("send", { count: 5 });

        await expect(limiter.limit("send", { throws: true })).rejects.toBeInstanceOf(RateLimitError);
    });

    test("unknown limit name throws", async () => {
        const limiter = makeLimiter();

        // @ts-expect-error -- "nope" is not a configured limit name.
        await expect(limiter.limit("nope")).rejects.toThrow(/not configured/);
    });
});

describe("check", () => {
    test("does not consume", async () => {
        const limiter = makeLimiter();

        await expect(limiter.check("send")).resolves.toMatchObject({ ok: true });

        // Still full — check never spent a token.
        const value = await limiter.getValue("send");

        expect(value.value).toBe(5);
    });
});

describe("getValue", () => {
    test("reports a full bucket for a key that has never been seen", async () => {
        const limiter = makeLimiter();

        const value = await limiter.getValue("send", { key: "fresh" });

        expect(value.value).toBe(5);
        expect(value.config).toMatchObject({ kind: "token bucket", rate: 5 });
    });
});

describe("reserve", () => {
    test("permits a deficit and persists the debt for later calls", async () => {
        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        await limiter.limit("send", { count: 5 });

        // No tokens left, but reserve lets two more through, going to -2.
        await expect(limiter.limit("send", { count: 2, reserve: true })).resolves.toMatchObject({ ok: true });

        const debt = await limiter.getValue("send");

        expect(debt.value).toBe(-2);
        // The debt is real: a plain consume still fails until tokens refill past 0.
        await expect(limiter.limit("send")).resolves.toMatchObject({ ok: false });
    });
});

describe("key derivation", () => {
    test("a limit named with the separator cannot collide with a keyed limit", async () => {
        const limiter = new RateLimiter({
            config: { "a:b": { kind: "fixed window", period: 1000, rate: 1 }, a: { kind: "fixed window", period: 1000, rate: 1 } },
            now: () => 0,
        });

        // Drain limit `a` under key `b`; the global `a:b` limit must stay untouched.
        await limiter.limit("a", { key: "b" });

        await expect(limiter.limit("a:b")).resolves.toMatchObject({ ok: true });
    });
});

describe("reset", () => {
    test("clears accumulated usage", async () => {
        const limiter = makeLimiter();

        await limiter.limit("send", { count: 5, key: "alice" });

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: false });

        await limiter.reset("send", { key: "alice" });

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: true });
    });
});

describe("deny list", () => {
    test("denies listed keys before any accounting", async () => {
        const limiter = makeLimiter({ denyList: ["banned"] });

        const status = await limiter.limit("send", { key: "banned" });

        expect(status).toMatchObject({ ok: false, reason: "deny" });
        expect(status.retryAfter).toBe(Number.POSITIVE_INFINITY);
    });

    test("leaves other keys unaffected", async () => {
        const limiter = makeLimiter({ denyList: ["banned"] });

        await expect(limiter.limit("send", { key: "allowed" })).resolves.toMatchObject({ ok: true });
    });
});

describe("clock progression", () => {
    test("a fixed-window limit recovers in the next window", async () => {
        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        await limiter.limit("login", { count: 3 });

        await expect(limiter.limit("login")).resolves.toMatchObject({ ok: false });

        clock.now = 1000;

        await expect(limiter.limit("login")).resolves.toMatchObject({ ok: true });
    });

    test("a sliding-window limit stays suppressed across the boundary until it decays", async () => {
        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        for (let index = 0; index < 4; index += 1) {
            await expect(limiter.limit("poll")).resolves.toMatchObject({ ok: true });
        }

        await expect(limiter.limit("poll")).resolves.toMatchObject({ ok: false, reason: "rate" });

        // The next window opens, but the full previous window still blocks it.
        clock.now = 1000;

        await expect(limiter.limit("poll")).resolves.toMatchObject({ ok: false });

        // Once the previous window has scrolled far enough out, requests flow again.
        clock.now = 1250;

        await expect(limiter.limit("poll")).resolves.toMatchObject({ ok: true });
    });
});
