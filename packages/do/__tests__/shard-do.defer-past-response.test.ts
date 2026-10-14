import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * `deferPastResponse` — the seam the generated mutation dispatch uses to flush
 * `ctx.storage`'s deferred object deletes after the transaction commits.
 *
 * The two behaviours that matter are the two hosts: one that can defer (the real
 * runtime, where the work must NOT be awaited on the response path) and one that
 * cannot (the unit harness and any host without `waitUntil`, where dropping the
 * work would turn a leaked object into a silently passing test).
 */
class DeferShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- required abstract override; this suite drives `deferPastResponse` directly, never a dispatch
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    public drive(work: Promise<unknown>): Promise<void> {
        return this.deferPastResponse(work);
    }
}

const baseState = (): ShardDOState => {
    return {
        acceptWebSocket: () => undefined,
        getWebSockets: () => [],
        id: { name: "shard-a" },
        storage: { sql: {} },
    };
};

describe("shardDO.deferPastResponse", () => {
    it("hands the work to the host and returns without awaiting it", async () => {
        expect.assertions(3);

        const deferred: Promise<unknown>[] = [];
        const state: ShardDOState = { ...baseState(), waitUntil: (promise) => deferred.push(promise) };
        const shard = new DeferShard(state, {});

        let settled = false;
        const work = new Promise<void>((resolve) => {
            setTimeout(() => {
                settled = true;
                resolve();
            }, 5);
        });

        await shard.drive(work);

        // Returned before the work finished — that is the point: a committed
        // mutation must not wait on object cleanup.
        expect(settled).toBe(false);
        expect(deferred).toHaveLength(1);

        await work;

        expect(settled).toBe(true);
    });

    it("awaits inline when the host cannot defer", async () => {
        expect.assertions(1);

        // No `waitUntil` on the state. Silently dropping the work here would make
        // an un-flushed delete queue look like correct behaviour under test.
        const shard = new DeferShard(baseState(), {});

        let settled = false;
        const work = new Promise<void>((resolve) => {
            setTimeout(() => {
                settled = true;
                resolve();
            }, 5);
        });

        await shard.drive(work);

        expect(settled).toBe(true);
    });
});
