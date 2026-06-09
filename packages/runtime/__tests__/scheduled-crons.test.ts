import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardSpy {
    calls: { body: unknown; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { body: unknown; shardKey: string }[] = [];

    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ body: await request.clone().json(), shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const CRON = "*/30 * * * *";

describe("createWorker — code-defined cron jobs", () => {
    it("dispatches every job declared under the firing expression to the shard", async () => {
        expect.assertions(4);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: {
                [CRON]: [
                    { args: { reason: "tick" }, functionPath: "presence:clear", name: "clear presence" },
                    { args: {}, functionPath: "digests:flush", name: "flush digests" },
                ],
            },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls).toHaveLength(2);
        expect(shard.calls[0]?.body).toStrictEqual({ args: { reason: "tick" }, functionPath: "presence:clear" });
        expect(shard.calls[1]?.body).toStrictEqual({ args: {}, functionPath: "digests:flush" });
        // Jobs without an explicit shardKey land on the default root shard.
        expect(shard.calls[0]?.shardKey).toBe("__root__");
    });

    it("does not dispatch jobs for a non-firing expression", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: "0 0 * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls).toHaveLength(0);
    });

    it("routes a job to its explicit shardKey", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "tenant:sweep", name: "sweep", shardKey: "tenant-7" }] },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        expect(shard.calls[0]?.shardKey).toBe("tenant-7");
    });

    it("rethrows when a dispatched job fails so the platform sees the cron invocation fail", async () => {
        expect.assertions(1);

        const shard = createShardSpy(new Response("boom", { status: 500 }));
        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
            shardDO: shard.namespace,
        });

        await expect(worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext)).rejects.toThrow(/clear presence/u);
    });

    it("denies dispatch when authorizeShard rejects the system identity", async () => {
        expect.assertions(2);

        const shard = createShardSpy();
        const authorizeShard = vi.fn<() => Promise<boolean>>(async () => false);
        const worker = createWorker({
            authorizeShard,
            cronJobs: { [CRON]: [{ args: {}, functionPath: "presence:clear", name: "clear presence" }] },
            shardDO: shard.namespace,
        });

        await expect(worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext)).rejects.toThrow(/Forbidden shard/u);
        expect(shard.calls).toHaveLength(0);
    });
});
