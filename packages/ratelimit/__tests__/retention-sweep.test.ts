import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enforcedCapacity, retentionMs } from "../src/algorithms";
import { RateLimiter } from "../src/rate-limiter";
import { createSqlStore } from "../src/store";
import type { RateLimitConfig, RateLimitStore } from "../src/types";
import createSqliteSql from "./_helpers/node-sqlite";

/** Park-Miller generator: a fixed seed makes any failure reproducible. */
const seeded = (seed: number): (() => number) => {
    let state = seed;

    return () => {
        state = (state * 48_271) % 2_147_483_647;

        return state / 2_147_483_647;
    };
};

const between = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

// The probe below needs refill still incomplete at HALF the retention horizon: an entry idle past that
// point must still decide differently from a fresh key. The token bucket and carried-capacity fixed
// window configs have that; a fixed window with no explicit capacity cannot, since its idle state
// projects to the same value as a fresh key, so it stays as a control.
const CONFIGS: [string, RateLimitConfig][] = [
    ["token bucket", { capacity: 8, kind: "token bucket", period: 1000, rate: 2 }],
    ["token bucket with a deep capacity", { capacity: 12, kind: "token bucket", period: 500, rate: 1 }],
    ["fixed window", { kind: "fixed window", period: 1000, rate: 3 }],
    ["fixed window with a carried capacity", { capacity: 4, kind: "fixed window", period: 1000, rate: 1 }],
    ["sliding window", { kind: "sliding window", period: 1000, rate: 4 }],
];

const rowCountOf = (sql: ReturnType<typeof createSqliteSql>["sql"]): number => {
    const [row] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "_lunora_rate_limits"`).toArray();

    return row?.n ?? 0;
};

describe("sweep does not change decisions (differential, real node:sqlite)", () => {
    let swept: ReturnType<typeof createSqliteSql>;
    let plain: ReturnType<typeof createSqliteSql>;

    beforeEach(() => {
        swept = createSqliteSql();
        plain = createSqliteSql();
    });

    afterEach(() => {
        swept.close();
        plain.close();
    });

    it.each(CONFIGS)("%s: identical decisions with and without the sweep, and the sweep removes rows", async (_label, config) => {
        expect.assertions(2);

        const sweptStore = createSqlStore({ sql: swept.sql });
        const plainStore = createSqlStore({ sql: plain.sql });
        // The control is the same store on its own database with the sweep hidden, so it keeps every row.
        const unsweptStore: RateLimitStore = { delete: plainStore.delete, get: plainStore.get, set: plainStore.set };
        const clock = { now: 0 };
        const retention = retentionMs([config]);
        const random = seeded(11);
        const sweptLimiter = new RateLimiter({ config: { lim: config }, now: () => clock.now, store: sweptStore });
        const unsweptLimiter = new RateLimiter({ config: { lim: config }, now: () => clock.now, store: unsweptStore });
        const decisionsSwept: unknown[] = [];
        const decisionsPlain: unknown[] = [];

        for (let step = 0; step < 3000; step += 1) {
            // Probe: drain a fresh key to zero, idle it past HALF the retention (never past the whole
            // of it), then write another key so the swept store sweeps before the probed key is read.
            // A shortened horizon deletes the probed row there, and the fresh key decides differently.
            if (random() < 0.03) {
                const probed = `probe-${String(step)}`;
                const cap = enforcedCapacity(config);

                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsSwept.push(await sweptLimiter.limit("lim", { count: cap, key: probed }));
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsPlain.push(await unsweptLimiter.limit("lim", { count: cap, key: probed }));

                clock.now += between(random, Math.floor(retention / 2) + 1, retention - 1);

                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsSwept.push(await sweptLimiter.limit("lim", { count: 1, key: `other-${String(step)}` }));
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsPlain.push(await unsweptLimiter.limit("lim", { count: 1, key: `other-${String(step)}` }));

                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsSwept.push(await sweptLimiter.limit("lim", { count: cap, key: probed }));
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsPlain.push(await unsweptLimiter.limit("lim", { count: cap, key: probed }));

                continue;
            }

            const roll = random();

            if (roll < 0.5) {
                clock.now += between(random, 0, 200);
            } else if (roll < 0.7) {
                clock.now += between(random, 0, Math.ceil(retention * 1.5));
            }

            const key = `k${String(between(random, 1, 30))}`;
            const action = random();

            if (action < 0.7) {
                const args = { count: between(random, 1, 3), key, reserve: random() < 0.15 };

                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsSwept.push(await sweptLimiter.limit("lim", args));
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsPlain.push(await unsweptLimiter.limit("lim", args));
            } else if (action < 0.85) {
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsSwept.push(await sweptLimiter.check("lim", { key }));
                // eslint-disable-next-line no-await-in-loop -- see above
                decisionsPlain.push(await unsweptLimiter.check("lim", { key }));
            } else {
                // eslint-disable-next-line no-await-in-loop -- see above
                await sweptLimiter.reset("lim", { key });
                // eslint-disable-next-line no-await-in-loop -- see above
                await unsweptLimiter.reset("lim", { key });
            }
        }

        expect(decisionsSwept).toEqual(decisionsPlain);
        // The sweep ran: fewer rows than the control that never sweeps.
        expect(rowCountOf(swept.sql)).toBeLessThan(rowCountOf(plain.sql));
    });
});

describe("durable table stays bounded under many distinct keys (real node:sqlite)", () => {
    let harness: ReturnType<typeof createSqliteSql>;

    beforeEach(() => {
        harness = createSqliteSql();
    });

    afterEach(() => {
        harness.close();
    });

    it("holds about one retention window of rows across 20,000 keys written 10 ms apart", async () => {
        expect.assertions(2);

        const config: RateLimitConfig = { kind: "fixed window", period: 1000, rate: 1 };
        const step = 10;
        const keys = 20_000;
        const retention = retentionMs([config]);
        // Rows written inside the horizon, plus the one row a write is adding.
        const bound = Math.ceil(retention / step) + 1;
        const clock = { now: 0 };
        const limiter = new RateLimiter({ config: { lim: config }, now: () => clock.now, store: createSqlStore({ sql: harness.sql }) });
        let peak = 0;

        for (let index = 0; index < keys; index += 1) {
            clock.now += step;

            // eslint-disable-next-line no-await-in-loop -- each write is the sweep's trigger
            await limiter.limit("lim", { key: `user-${String(index)}` });

            peak = Math.max(peak, rowCountOf(harness.sql));
        }

        // Peak tracks the bound from below too, so a sweep that deletes everything fails.
        expect(peak).toBeLessThanOrEqual(bound);
        expect(peak).toBeGreaterThanOrEqual(Math.floor(retention / step) - 1);
    });
});
