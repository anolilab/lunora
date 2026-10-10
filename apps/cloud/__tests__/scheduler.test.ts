import { describe, expect, it } from "vitest";

import { ConvergeScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";

describe(ConvergeScheduler, () => {
    it("returns task results and passes values through when budget is ample", async () => {
        const scheduler = new ConvergeScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

        const results = await Promise.all([
            scheduler.run(() => Promise.resolve(1)),
            scheduler.run(() => Promise.resolve(2)),
            scheduler.run(() => Promise.resolve(3)),
        ]);

        expect(results).toStrictEqual([1, 2, 3]);
    });

    it("drains queued work in priority order when budget is scarce", async () => {
        let clock = 0;
        const now = (): number => clock;
        // A manual clock: sleeping advances time so the bucket refills deterministically.
        const sleep = (ms: number): Promise<void> => {
            clock += ms;

            return Promise.resolve();
        };
        // 1 token per 100ms, starting full (1 token).
        const bucket = new TokenBucket({ capacity: 1, now, refillPerWindow: 1, windowMs: 100 });
        const scheduler = new ConvergeScheduler({ bucket, now, sleep });

        // Spend the only available token so the next submissions all queue.
        bucket.tryRemove(0);

        const order: string[] = [];
        const record = (label: string) => () => {
            order.push(label);

            return Promise.resolve();
        };

        await Promise.all([
            scheduler.run(record("low"), { priority: 0 }),
            scheduler.run(record("high"), { priority: 10 }),
            scheduler.run(record("medium"), { priority: 5 }),
        ]);

        expect(order).toStrictEqual(["high", "medium", "low"]);
    });

    it("propagates task rejection to the caller", async () => {
        const scheduler = new ConvergeScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) });

        await expect(scheduler.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });

    it("runs without a budget, paced by its concurrency alone, and reports when it is idle", async () => {
        let clock = 0;
        const bucket = new TokenBucket({ capacity: 2, now: () => clock, refillPerWindow: 2, windowMs: 1000 });
        const metered = new ConvergeScheduler({ bucket, now: () => clock });
        const unmetered = new ConvergeScheduler({ maxConcurrent: 1 });

        await expect(Promise.all([unmetered.run(() => Promise.resolve("a")), unmetered.run(() => Promise.resolve("b"))])).resolves.toStrictEqual(["a", "b"]);
        expect(unmetered.idle()).toBe(true);

        await metered.run(() => Promise.resolve());

        // A token spent: not idle until the bucket has refilled, since a fresh scheduler would forget the spend.
        expect(metered.idle()).toBe(false);

        clock += 1000;

        expect(metered.idle()).toBe(true);
    });
});
