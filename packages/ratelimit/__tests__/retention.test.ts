import { describe, expect, it, vi } from "vitest";

import { availableAt, enforcedCapacity, retentionMs } from "../src/algorithms";
import { RateLimiter } from "../src/rate-limiter";
import { createMemoryStore } from "../src/store";
import type { RateLimitConfig, RateLimitStore, RateLimitValue } from "../src/types";

/** Park-Miller generator: a fixed seed makes any failure reproducible. */
const seeded = (seed: number): (() => number) => {
    let state = seed;

    return () => {
        state = (state * 48_271) % 2_147_483_647;

        return state / 2_147_483_647;
    };
};

const between = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

const randomConfig = (random: () => number): RateLimitConfig => {
    const kinds = ["token bucket", "fixed window", "sliding window"] as const;
    const kind = kinds[between(random, 0, 2)] as RateLimitConfig["kind"];
    const rate = between(random, 1, 20);
    const period = between(random, 100, 5000);
    const start = between(random, 0, period - 1);
    const capacity = kind !== "sliding window" && random() < 0.5 ? between(random, 1, 40) : undefined;

    return { capacity, kind, period, rate, start };
};

describe("retentionMs horizon", () => {
    it("makes a stored non-negative state project to a fresh key's availability", () => {
        expect.assertions(10_000);

        const random = seeded(7);
        const cases = 10_000;

        for (let index = 0; index < cases; index += 1) {
            const config = randomConfig(random);
            const retention = retentionMs([config]);
            const capacity = enforcedCapacity(config);
            const ts = between(random, 0, 1_000_000);
            const prior: RateLimitValue = { ts, value: Math.floor(random() * (capacity + 1)) };

            if (config.kind === "sliding window") {
                prior.prev = between(random, 0, config.rate);
            }

            const at = ts + retention;

            expect(availableAt(config, prior, at)).toEqual(availableAt(config, undefined, at));
        }
    });

    it("does not hold for a reserved debt, which is why the store keeps debts", () => {
        expect.assertions(2);

        const config: RateLimitConfig = { capacity: 10, kind: "token bucket", period: 1000, rate: 1 };
        const prior: RateLimitValue = { ts: 0, value: -10 };
        const at = retentionMs([config]) + prior.ts;

        // The debt still has 8 tokens to repay at the horizon, so it is not equivalent to a
        // fresh bucket.
        expect(availableAt(config, prior, at).value).toBe(2);
        expect(availableAt(config, undefined, at).value).toBe(10);
    });
});

describe("memory store sweep", () => {
    it("moves a rewritten key to the end, so the oldest entries sit at the front", async () => {
        expect.assertions(2);

        const store = createMemoryStore();

        await store.set("a", { ts: 1, value: 1 });
        await store.set("b", { ts: 2, value: 1 });
        await store.set("a", { ts: 3, value: 1 });
        await store.sweep?.(2, 10);

        expect(store.get("b")).toBeUndefined();
        expect(store.get("a")).toEqual({ ts: 3, value: 1 });
    });

    it("removes at most `limit` entries and keeps the live ones", async () => {
        expect.assertions(3);

        const store = createMemoryStore();

        await Promise.all(Array.from({ length: 5 }, async (_, index) => store.set(`k${String(index)}`, { ts: 1, value: 1 })));

        await store.set("live", { ts: 100, value: 1 });
        await store.sweep?.(10, 3);

        expect(store.get("k2")).toBeUndefined();
        expect(store.get("k3")).toEqual({ ts: 1, value: 1 });
        expect(store.get("live")).toEqual({ ts: 100, value: 1 });
    });

    it("keeps a reserved debt, and does not let it block the entries behind it", async () => {
        expect.assertions(2);

        const store = createMemoryStore();

        await store.set("debt", { ts: 1, value: -4 });
        await store.set("spent", { ts: 1, value: 0 });
        await store.sweep?.(10, 2);

        expect(store.get("debt")).toEqual({ ts: 1, value: -4 });
        expect(store.get("spent")).toBeUndefined();
    });
});

describe("limiter retention", () => {
    it("bounds the store across 200k distinct keys and keeps only recent entries", async () => {
        expect.assertions(3);

        const keys = 200_000;

        let clock = 0;
        const store = createMemoryStore();
        const limiter = new RateLimiter({
            config: { perIp: { kind: "fixed window", period: 1000, rate: 1 } },
            now: () => clock,
            store,
        });

        for (let index = 0; index < keys; index += 1) {
            clock += 1;
            // eslint-disable-next-line no-await-in-loop -- the probe must advance the clock per key
            await limiter.limit("perIp", { key: `ip-${String(index)}` });
        }

        let retained = 0;

        for (let index = 0; index < keys; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- reads one memory-store entry at a time
            if ((await store.get(`perIp:ip-${String(index)}`)) !== undefined) {
                retained += 1;
            }
        }

        // Retention is 3 periods (3000 ms at 1 key/ms), so only the last few thousand survive.
        expect(retained).toBeLessThan(3100);
        expect(retained).toBeGreaterThan(2900);
        expect(store.get(`perIp:ip-${String(keys - 1)}`)).toBeDefined();
    });
});

describe("differential: sweep never changes a decision", () => {
    const config: Record<string, RateLimitConfig> = {
        bucket: { capacity: 10, kind: "token bucket", period: 1000, rate: 3 },
        fixed: { capacity: 9, kind: "fixed window", period: 1000, rate: 4, start: 250 },
        sliding: { kind: "sliding window", period: 1000, rate: 5 },
        windowDefault: { kind: "fixed window", period: 700, rate: 6 },
    };
    const names = Object.keys(config);

    /** A store with no `sweep` member, so the limiter never sweeps it. */
    const withoutSweep = (full: RateLimitStore): RateLimitStore => {
        return {
            delete: full.delete,
            get: full.get,
            set: full.set,
        };
    };

    const advance = (random: () => number): number => {
        const roll = random();

        if (roll < 0.7) {
            return between(random, 0, 50);
        }

        return roll < 0.9 ? between(random, 500, 3000) : between(random, 3000, 20_000);
    };

    /** Run one seeded sequence through a swept and an unswept limiter; return every divergence. */
    const diverges = async (seed: number, operations: number): Promise<string[]> => {
        const random = seeded(seed);
        let clock = 1_000_000;
        const now = (): number => clock;
        const swept = new RateLimiter({ config, now, store: createMemoryStore() });
        const plain = new RateLimiter({ config, now, store: withoutSweep(createMemoryStore()) });
        const mismatches: string[] = [];

        const compare = (label: string, a: unknown, b: unknown): void => {
            if (JSON.stringify(a) !== JSON.stringify(b)) {
                mismatches.push(`${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
            }
        };

        for (let step = 0; step < operations; step += 1) {
            clock += advance(random);

            const name = names[between(random, 0, names.length - 1)] as string;
            // A small key pool with mostly full-capacity reserves stacks debts deeper than one
            // horizon, which is the case a too-short retention gets wrong.
            const key = `k${String(between(random, 0, 9))}`;
            const cap = enforcedCapacity(config[name] as RateLimitConfig);
            const count = random() < 0.6 ? cap : between(random, 1, cap);
            const reserve = random() < 0.6;
            const label = `step ${String(step)} ${name}/${key}`;
            const op = random();

            if (op < 0.05) {
                // eslint-disable-next-line no-await-in-loop -- see below
                await Promise.all([swept.reset(name, { key }), plain.reset(name, { key })]);
            } else if (op < 0.8) {
                // eslint-disable-next-line no-await-in-loop -- compare the two limiters op by op
                compare(`${label} limit`, await swept.limit(name, { count, key, reserve }), await plain.limit(name, { count, key, reserve }));
            } else if (op < 0.9) {
                // eslint-disable-next-line no-await-in-loop -- see above
                compare(`${label} check`, await swept.check(name, { key }), await plain.check(name, { key }));
            } else {
                // eslint-disable-next-line no-await-in-loop -- see above
                compare(`${label} getValue`, await swept.getValue(name, { key }), await plain.getValue(name, { key }));
            }
        }

        return mismatches;
    };

    it("matches an unswept limiter on every op across 20 seeded sequences", async () => {
        expect.assertions(20);

        for (let seed = 1; seed <= 20; seed += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequences are independent and small
            await expect(diverges(seed, 5000)).resolves.toEqual([]);
        }
    });
});

describe("sweep horizon ownership and clock", () => {
    it("keeps another limiter's live entries when both sweep one store", async () => {
        expect.assertions(2);

        let clock = 0;
        const now = (): number => clock;
        const store = createMemoryStore();
        const login = new RateLimiter({ config: { login: { kind: "fixed window", period: 60_000, rate: 1 } }, now, store });
        const send = new RateLimiter({ config: { send: { kind: "fixed window", period: 1000, rate: 1 } }, now, store });

        // The login window (retention 3 minutes) is still live when `send` sweeps with its own, shorter horizon.
        await login.limit("login", { key: "u" });

        for (let index = 0; index < 50; index += 1) {
            clock += 100;
            // eslint-disable-next-line no-await-in-loop -- each write triggers a sweep in order
            await send.limit("send", { key: `k${String(index)}` });
        }

        const status = await login.check("login", { key: "u" });

        expect(store.get("login:u")).toBeDefined();
        expect(status.ok).toBe(false);
    });

    it("decides from the config as it was at construction, not a later mutation of it", async () => {
        expect.assertions(2);

        let clock = 0;
        const now = (): number => clock;
        const mutated = { login: { kind: "fixed window" as const, period: 1000, rate: 1 } };
        const untouched = { login: { kind: "fixed window" as const, period: 1000, rate: 1 } };
        const limiterA = new RateLimiter({ config: mutated, now, store: createMemoryStore() });
        const limiterB = new RateLimiter({ config: untouched, now, store: createMemoryStore() });

        await limiterA.limit("login", { key: "u" });
        await limiterB.limit("login", { key: "u" });

        // Lengthen A's limit after construction. Its horizon must not change, so a
        // later sweep cannot evict an entry A still needs earlier than B would.
        mutated.login.period = 100_000;

        clock = 1500;
        const a = await limiterA.limit("login", { key: "u" });
        const b = await limiterB.limit("login", { key: "u" });

        expect(a).toEqual(b);
        expect(a.ok).toBe(true);
    });

    it("does not fail a consume whose write landed when the sweep throws", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const store = {
            ...createMemoryStore(),
            sweep: (): void => {
                throw new Error("boom");
            },
        };
        const limiter = new RateLimiter({ config: { send: { kind: "fixed window", period: 1000, rate: 1 } }, now: () => 0, store });

        await expect(limiter.limit("send", { key: "u" })).resolves.toMatchObject({ ok: true });
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("does not revive a spent bucket when the clock rolls back", async () => {
        expect.assertions(2);

        let clock = 5000;
        const limiter = new RateLimiter({
            config: { send: { kind: "fixed window", period: 1000, rate: 1 } },
            now: () => clock,
            store: createMemoryStore(),
        });

        const first = await limiter.limit("send", { key: "u" });

        expect(first.ok).toBe(true);

        clock = 0;

        const replayed = await limiter.limit("send", { key: "u" });

        expect(replayed.ok).toBe(false);
    });
});
