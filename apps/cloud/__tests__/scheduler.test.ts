import { describe, expect, it } from "vitest";

import { CellScheduler } from "../src/deploy/scheduler";
import { TokenBucket } from "../src/deploy/token-bucket";

describe(CellScheduler, () => {
    it("returns task results and passes values through when budget is ample", async () => {
        const scheduler = new CellScheduler({ bucket: new TokenBucket({ capacity: 100, refillPerWindow: 100, windowMs: 1000 }) });

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
        const scheduler = new CellScheduler({ bucket, now, sleep });

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
        const scheduler = new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) });

        await expect(scheduler.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
});
