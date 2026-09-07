import { describe, expect, it, vi } from "vitest";

import RateLimitError from "../src/error";
import { RateLimiter } from "../src/rate-limiter";
import { createMemoryStore } from "../src/store";
import type { RateLimitConfigMap } from "../src/types";

const NOT_CONFIGURED_RE = /not configured/;
const POSITIVE_INTEGER_RE = /positive integer/;
const POSITIVE_PERIOD_RE = /period must be a positive number/;
const POSITIVE_RATE_RE = /rate must be a positive number/;
const NON_NEGATIVE_CAPACITY_RE = /capacity must be a non-negative number/;

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
    it("consumes capacity and then rejects", async () => {
        expect.hasAssertions();

        const limiter = makeLimiter();

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- ordered stateful calls
            await expect(limiter.limit("send")).resolves.toMatchObject({ ok: true });
        }

        await expect(limiter.limit("send")).resolves.toMatchObject({ ok: false, reason: "rate" });
    });

    it("isolates separate keys", async () => {
        expect.hasAssertions();

        const limiter = makeLimiter();

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- ordered stateful calls
            await limiter.limit("send", { key: "alice" });
        }

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: false });
        // Bob's bucket is untouched.
        await expect(limiter.limit("send", { key: "bob" })).resolves.toMatchObject({ ok: true });
    });

    it("count consumes multiple units at once", async () => {
        expect.assertions(2);

        const limiter = makeLimiter();

        await expect(limiter.limit("send", { count: 5 })).resolves.toMatchObject({ ok: true });
        await expect(limiter.limit("send", { count: 1 })).resolves.toMatchObject({ ok: false });
    });

    it("throws RateLimitError when throws is set", async () => {
        expect.assertions(1);

        const limiter = makeLimiter();

        await limiter.limit("send", { count: 5 });

        await expect(limiter.limit("send", { throws: true })).rejects.toBeInstanceOf(RateLimitError);
    });

    it("unknown limit name throws", async () => {
        expect.assertions(1);

        const limiter = makeLimiter();

        // @ts-expect-error -- "nope" is not a configured limit name.
        await expect(limiter.limit("nope")).rejects.toThrow(NOT_CONFIGURED_RE);
    });
});

describe("check", () => {
    it("does not consume", async () => {
        expect.assertions(2);

        const limiter = makeLimiter();

        await expect(limiter.check("send")).resolves.toMatchObject({ ok: true });

        // Still full — check never spent a token.
        const value = await limiter.getValue("send");

        expect(value.value).toBe(5);
    });
});

describe("getValue", () => {
    it("reports a full bucket for a key that has never been seen", async () => {
        expect.assertions(2);

        const limiter = makeLimiter();

        const value = await limiter.getValue("send", { key: "fresh" });

        expect(value.value).toBe(5);
        expect(value.config).toMatchObject({ kind: "token bucket", rate: 5 });
    });
});

describe("reserve", () => {
    it("permits a deficit and persists the debt for later calls", async () => {
        expect.assertions(3);

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

    it("getValue surfaces a fixed-window reserve debt as a negative figure", async () => {
        expect.assertions(1);

        const limiter = makeLimiter();

        // Drain the window, then borrow one more against it via reserve.
        await limiter.limit("login", { count: 3 });
        await limiter.limit("login", { reserve: true });

        // getValue reports the live signed balance: -1 means the window owes a
        // unit before any fresh capacity is admittable (mirrors the token-bucket
        // debt contract above).
        const value = await limiter.getValue("login");

        expect(value.value).toBe(-1);
    });
});

describe("key derivation", () => {
    it("a limit named with the separator cannot collide with a keyed limit", async () => {
        expect.assertions(1);

        const limiter = new RateLimiter({
            config: { a: { kind: "fixed window", period: 1000, rate: 1 }, "a:b": { kind: "fixed window", period: 1000, rate: 1 } },
            now: () => 0,
        });

        // Drain limit `a` under key `b`; the global `a:b` limit must stay untouched.
        await limiter.limit("a", { key: "b" });

        await expect(limiter.limit("a:b")).resolves.toMatchObject({ ok: true });
    });
});

describe("reset", () => {
    it("clears accumulated usage", async () => {
        expect.assertions(2);

        const limiter = makeLimiter();

        await limiter.limit("send", { count: 5, key: "alice" });

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: false });

        await limiter.reset("send", { key: "alice" });

        await expect(limiter.limit("send", { key: "alice" })).resolves.toMatchObject({ ok: true });
    });
});

describe("deny list", () => {
    it("denies listed keys before any accounting", async () => {
        expect.assertions(2);

        const limiter = makeLimiter({ denyList: ["banned"] });

        const status = await limiter.limit("send", { key: "banned" });

        expect(status).toMatchObject({ ok: false, reason: "deny" });
        expect(status.retryAfter).toBe(Number.POSITIVE_INFINITY);
    });

    it("leaves other keys unaffected", async () => {
        expect.assertions(1);

        const limiter = makeLimiter({ denyList: ["banned"] });

        await expect(limiter.limit("send", { key: "allowed" })).resolves.toMatchObject({ ok: true });
    });

    it("matches a deny-list entry against the raw, pre-normalized key", async () => {
        expect.assertions(1);

        // The deny-list holds the raw form; normalize lower-cases the storage key.
        // The raw input must still be denied even though it differs from the
        // normalized (canonical) form.
        const limiter = new RateLimiter({
            config,
            denyList: ["Banned"],
            normalize: (key) => key.toLowerCase(),
            now: () => 0,
        });

        await expect(limiter.limit("send", { key: "Banned" })).resolves.toMatchObject({ ok: false, reason: "deny" });
    });

    it("matches a raw deny-list entry against an equivalent normalized key", async () => {
        expect.assertions(1);

        // The deny-list holds the raw form and the request arrives already in
        // the normalized form — the ban must still hold. Both forms route to
        // the SAME storage bucket, so admitting here would let a banned caller
        // shed the ban simply by lower-casing their own email.
        const limiter = new RateLimiter({
            config,
            denyList: ["Abuse@Example.com "],
            normalize: (key) => key.trim().toLowerCase(),
            now: () => 0,
            store: createMemoryStore(),
        });

        await expect(limiter.limit("send", { key: "abuse@example.com" })).resolves.toMatchObject({ ok: false, reason: "deny" });
    });
});

describe("normalize", () => {
    it("folds equivalent keys into a single bucket", async () => {
        expect.assertions(2);

        const limiter = new RateLimiter({
            config,
            normalize: (key) => key.trim().toLowerCase(),
            now: () => 0,
        });

        await limiter.limit("send", { count: 5, key: "Alice" });

        // " alice " normalizes to the same bucket "Alice" drained.
        await expect(limiter.limit("send", { key: " alice " })).resolves.toMatchObject({ ok: false });
        // A genuinely different key is untouched.
        await expect(limiter.limit("send", { key: "bob" })).resolves.toMatchObject({ ok: true });
    });
});

describe("clock progression", () => {
    it("a fixed-window limit recovers in the next window", async () => {
        expect.assertions(2);

        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        await limiter.limit("login", { count: 3 });

        await expect(limiter.limit("login")).resolves.toMatchObject({ ok: false });

        clock.now = 1000;

        await expect(limiter.limit("login")).resolves.toMatchObject({ ok: true });
    });

    it("a sliding-window limit stays suppressed across the boundary until it decays", async () => {
        expect.hasAssertions();

        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        for (let index = 0; index < 4; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- ordered stateful calls
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

describe("live refill", () => {
    it("getValue projects token-bucket refill to the current clock", async () => {
        expect.assertions(2);

        const clock = { now: 0 };
        const limiter = makeLimiter({ clock });

        await limiter.limit("send", { count: 5 });

        // Drained now; nothing to spend.
        const drained = await limiter.getValue("send");

        expect(drained.value).toBe(0);

        // Half a period later, the 5/1000ms refill has accrued 2.5 tokens — a live
        // figure, not the 0 that was persisted.
        clock.now = 500;

        const refilled = await limiter.getValue("send");

        expect(refilled.value).toBe(2.5);
    });
});

describe("sharding", () => {
    const shardedConfig = { hits: { kind: "token bucket", period: 1000, rate: 4, shards: 2 } } satisfies RateLimitConfigMap<"hits">;

    const shardedLimiter = () => new RateLimiter({ config: shardedConfig, now: () => 0 });

    it("same key always lands on the same shard (deterministic)", async () => {
        expect.assertions(3);

        const limiter = shardedLimiter();

        // Per-shard capacity is rate/shards = 2. A single key drains exactly
        // its own shard's worth of tokens — no more, no less — because every
        // call hashes to the same shard.
        await expect(limiter.limit("hits", { key: "alice" })).resolves.toMatchObject({ ok: true });
        await expect(limiter.limit("hits", { key: "alice" })).resolves.toMatchObject({ ok: true });
        await expect(limiter.limit("hits", { key: "alice" })).resolves.toMatchObject({ ok: false, reason: "rate" });
    });

    it("getValue reflects the single shard the key routes to", async () => {
        expect.assertions(3);

        const limiter = shardedLimiter();

        const full = await limiter.getValue("hits", { key: "alice" });

        // Per-shard capacity is rate/shards = 2. getValue routes to the SAME
        // single shard limit()/run() use for this key, so it reports that
        // bucket's capacity (2) — NOT the summed capacity of every shard.
        // Summing would over-report what `alice` can actually consume.
        expect(full.value).toBe(2);
        expect(full.config).toMatchObject({ rate: 4, shards: 2 });

        await limiter.limit("hits", { key: "alice" });
        await limiter.limit("hits", { key: "alice" });

        // Alice's shard is now drained, so getValue for her key reports 0.
        const drained = await limiter.getValue("hits", { key: "alice" });

        expect(drained.value).toBe(0);
    });

    it("reset clears every shard", async () => {
        expect.assertions(2);

        const limiter = shardedLimiter();

        await limiter.limit("hits", { key: "alice" });
        await limiter.limit("hits", { key: "alice" });

        await expect(limiter.limit("hits", { key: "alice" })).resolves.toMatchObject({ ok: false });

        await limiter.reset("hits", { key: "alice" });

        await expect(limiter.limit("hits", { key: "alice" })).resolves.toMatchObject({ ok: true });
    });

    it("rejects a non-integer shard count at construction", () => {
        expect.assertions(1);

        expect(() => new RateLimiter({ config: { hits: { kind: "token bucket", period: 1000, rate: 4, shards: 1.5 } }, now: () => 0 })).toThrow(
            POSITIVE_INTEGER_RE,
        );
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-positive/non-finite period (%p) at construction", (period) => {
        expect.assertions(1);

        expect(() => new RateLimiter({ config: { hits: { kind: "token bucket", period, rate: 4 } }, now: () => 0 })).toThrow(POSITIVE_PERIOD_RE);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a non-positive/non-finite rate (%p) at construction", (rate) => {
        expect.assertions(1);

        expect(() => new RateLimiter({ config: { hits: { kind: "token bucket", period: 1000, rate } }, now: () => 0 })).toThrow(POSITIVE_RATE_RE);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a negative/non-finite capacity (%p) at construction", (capacity) => {
        expect.assertions(1);

        expect(() => new RateLimiter({ config: { hits: { kind: "token bucket", capacity, period: 1000, rate: 4 } }, now: () => 0 })).toThrow(
            NON_NEGATIVE_CAPACITY_RE,
        );
    });
});

describe("no-store warning", () => {
    it("warns once when constructed with no explicit store, naming the durable store options", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const limiter = new RateLimiter({ config, now: () => 0 });

        expect(limiter).toBeInstanceOf(RateLimiter);
        expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/createDbStore/));

        warn.mockRestore();
    });

    it("does not warn when constructed with an explicit store", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const limiter = new RateLimiter({ config, now: () => 0, store: createMemoryStore() });

        await expect(limiter.check("send")).resolves.toMatchObject({ ok: true });
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    it("fires once per construction, not once per check/limit call", async () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const limiter = new RateLimiter({ config, now: () => 0 });

        await limiter.check("send");
        await limiter.limit("send");
        await limiter.limit("send");

        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("does not change limiting behaviour, with or without an explicit store (regression guard)", async () => {
        expect.hasAssertions();

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const clockA = { now: 0 };
        const clockB = { now: 0 };
        const withDefaultStore = new RateLimiter({ config, now: () => clockA.now });
        const withExplicitStore = new RateLimiter({ config, now: () => clockB.now, store: createMemoryStore() });

        for (let index = 0; index < 6; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- ordered stateful calls, comparing the two limiters call-for-call
            const [defaultResult, explicitResult] = await Promise.all([withDefaultStore.limit("send"), withExplicitStore.limit("send")]);

            expect(defaultResult).toStrictEqual(explicitResult);
        }

        warn.mockRestore();
    });
});
