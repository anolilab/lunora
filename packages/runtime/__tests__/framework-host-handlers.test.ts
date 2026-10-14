import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { withFrameworkWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const shardNamespace = (): ShardNamespaceLike => {
    return {
        get: () => {
            return { fetch: async () => new Response("{}", { status: 200 }) };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/**
 * The exact shape codegen commits: `_generated/app.ts` passes `cronJobs:
 * LUNORA_CRONS` unconditionally and `_generated/crons.ts` exports `{}` for a
 * cron-free app. Fixed here so `scheduled` ownership never confounds the
 * queue/email assertions.
 */
const generatedCronFreeOptions = { cronJobs: {}, crons: {} };

type HostEmail = (message: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;
type HostQueue = (batch: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;

describe("withFrameworkWorker — `queue` / `email` ownership", () => {
    it("keeps the framework host's queue consumer when Lunora declares no push queues", async () => {
        expect.assertions(2);

        const hostQueue = vi.fn<HostQueue>(async () => undefined);

        const worker = withFrameworkWorker({ fetch: () => new Response("ssr"), queue: hostQueue }, { ...generatedCronFreeOptions, shardDO: shardNamespace() });

        await worker.queue?.({ messages: [], queue: "mail" }, {}, fakeContext);

        // On workerd a consumer that returns without throwing IMPLICITLY ACKS the
        // batch, so Lunora's no-op `queue` does not merely ignore the host's
        // messages — it destroys them.
        expect(hostQueue).toHaveBeenCalledTimes(1);
        expect(hostQueue.mock.calls[0]![0]).toStrictEqual({ messages: [], queue: "mail" });
    });

    it("takes queue over from the host once Lunora owns a push-queue consumer", async () => {
        expect.assertions(2);

        const hostQueue = vi.fn<HostQueue>(async () => undefined);
        const lunoraQueue = vi.fn<() => Promise<undefined>>(async () => undefined);

        const worker = withFrameworkWorker(
            { fetch: () => new Response("ssr"), queue: hostQueue },
            { ...generatedCronFreeOptions, queue: lunoraQueue, shardDO: shardNamespace() },
        );

        await worker.queue?.({ messages: [], queue: "mail" }, {}, fakeContext);

        expect(hostQueue).not.toHaveBeenCalled();
        expect(lunoraQueue).toHaveBeenCalledTimes(1);
    });

    it("preserves the framework host's email entry, which Lunora never provides", async () => {
        expect.assertions(2);

        const hostEmail = vi.fn<HostEmail>(async () => undefined);

        const worker = withFrameworkWorker({ email: hostEmail, fetch: () => new Response("ssr") }, { ...generatedCronFreeOptions, shardDO: shardNamespace() });

        await worker.email?.({ from: "a@b.test" }, {}, fakeContext);

        expect(hostEmail).toHaveBeenCalledTimes(1);
        expect(hostEmail.mock.calls[0]![0]).toStrictEqual({ from: "a@b.test" });
    });

    it("exposes no email entry when the host has none, so wrangler sees the same module shape", () => {
        expect.assertions(1);

        const worker = withFrameworkWorker({ fetch: () => new Response("ssr") }, { ...generatedCronFreeOptions, shardDO: shardNamespace() });

        expect(worker.email).toBeUndefined();
    });

    it("keeps queue and email across the per-request options factory form", async () => {
        expect.assertions(2);

        const hostEmail = vi.fn<HostEmail>(async () => undefined);
        const hostQueue = vi.fn<HostQueue>(async () => undefined);

        const worker = withFrameworkWorker({ email: hostEmail, fetch: () => new Response("ssr"), queue: hostQueue }, () => {
            return { ...generatedCronFreeOptions, shardDO: shardNamespace() };
        });

        await worker.queue?.({ messages: [], queue: "mail" }, {}, fakeContext);
        await worker.email?.({ from: "a@b.test" }, {}, fakeContext);

        expect(hostQueue).toHaveBeenCalledTimes(1);
        expect(hostEmail).toHaveBeenCalledTimes(1);
    });
});
