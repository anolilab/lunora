import { describe, expect, it } from "vitest";

import { runSocketPool } from "../src/socket-pool";

/** A deferred whose `resolve` is callable from outside the executor. */
const defer = (): { promise: Promise<void>; resolve: () => void } => {
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
    });

    return { promise, resolve: resolveFn };
};

describe(runSocketPool, () => {
    it("visits every item exactly once", async () => {
        expect.assertions(2);

        const items = Array.from({ length: 25 }, (_, index) => index);
        const visits: number[] = [];

        await runSocketPool(items, (item) => {
            visits.push(item);

            return Promise.resolve();
        });

        expect(visits).toHaveLength(items.length);
        expect(visits.toSorted((a, b) => a - b)).toStrictEqual(items);
    });

    it("never runs more than `concurrency` workers at once", async () => {
        expect.assertions(2);

        const items = Array.from({ length: 20 }, (_, index) => index);
        const gates = items.map(() => defer());

        let active = 0;
        let peak = 0;

        const run = runSocketPool(
            items,
            async (item) => {
                active += 1;
                peak = Math.max(peak, active);
                await gates[item]?.promise;
                active -= 1;
            },
            4,
        );

        // Let the workers ramp up, then release the gates in waves.
        for (const gate of gates) {
            // eslint-disable-next-line no-await-in-loop -- intentionally yield a microtask between gate releases so workers ramp up before draining
            await Promise.resolve();
            gate.resolve();
        }

        await run;

        // At most 4 in flight at any moment, and the pool actually parallelized.
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBe(4);
    });

    it("no-ops on an empty list and caps workers at the item count", async () => {
        expect.assertions(2);

        const empty: number[] = [];
        let calls = 0;

        await runSocketPool(empty, () => {
            calls += 1;

            return Promise.resolve();
        });

        expect(calls).toBe(0);

        // Fewer items than the default concurrency: every item still runs once.
        const visits: number[] = [];

        await runSocketPool([1, 2], (item) => {
            visits.push(item);

            return Promise.resolve();
        });

        expect(visits.toSorted((a, b) => a - b)).toStrictEqual([1, 2]);
    });

    it("contains a per-item failure so the remaining items still run", async () => {
        expect.assertions(2);

        const items = [0, 1, 2, 3, 4];
        const visited: number[] = [];

        // Item 2 rejects; the pool must swallow it and keep draining the rest.
        await runSocketPool(
            items,
            (item) => {
                visited.push(item);

                return item === 2 ? Promise.reject(new Error("boom")) : Promise.resolve();
            },
            1,
        );

        expect(visited.toSorted((a, b) => a - b)).toStrictEqual(items);
        expect(visited).toContain(4);
    });
});
