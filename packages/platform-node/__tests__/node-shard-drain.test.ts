import { resolveShard } from "@lunora/platform";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodePlatform } from "../src/node-platform";
import { createNodeShardRegistry } from "../src/node-shard-registry";

/** A promise the test settles by hand: work that is "in flight" until the test says otherwise. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

/** One full event-loop turn: every microtask a non-waiting drain would need to settle has run. */
const turn = async (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve);
    });

describe("shard drain", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("waits for an in-flight onFetch, such as a cron delivery, before the registry reports idle", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));
            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("waits for work a shard handed to waitUntil, and for work a request started there", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: (_request, shard) => {
                const background = async (): Promise<void> => {
                    await gate.promise;
                    events.push("background done");
                };

                shard.shard.waitUntil?.(background());

                return new Response("ok");
            },
        });

        try {
            await registry.directory.getByName("a").fetch(new Request("https://shard.internal/rpc"));

            const drained = registry.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await drained;

            expect(events).toStrictEqual(["background done", "drained"]);
        } finally {
            registry.close();
        }
    });

    it("includes the registry's shards in the platform's drain", async () => {
        expect.assertions(1);

        const gate = deferred();
        const events: string[] = [];
        const platform = createNodePlatform({
            onFetch: async () => {
                await gate.promise;
                events.push("fetch done");

                return new Response("ok");
            },
        });

        try {
            const request = resolveShard(platform.directory, "a").fetch(new Request("https://shard.internal/rpc"));
            const drained = platform.drain().then(() => events.push("drained"));

            await turn();
            gate.release();
            await Promise.all([request, drained]);

            expect(events).toStrictEqual(["fetch done", "drained"]);
        } finally {
            platform.close();
        }
    });
});

describe("background failures", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("logs a rejected waitUntil with the error object, so its stack and cause print", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const registry = createNodeShardRegistry();
        const failure = new Error("background write failed", { cause: new Error("disk full") });

        try {
            registry.shardFor("a").shard.waitUntil?.(Promise.reject(failure));
            await registry.drain();

            expect(logged).toHaveBeenCalledWith(expect.stringContaining("waitUntil on shard a failed"), failure);
            expect((logged.mock.calls[0]?.[1] as Error).cause).toStrictEqual(new Error("disk full"));
        } finally {
            registry.close();
        }
    });

    it("logs a scheduled job whose delivery throws, naming the job, before it is retried", async () => {
        expect.assertions(1);

        const failure = new Error("delivery refused");
        const reported = deferred();
        const logged = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
            if (parts.includes(failure)) {
                reported.release();
            }
        });
        const platform = createNodePlatform({
            onDispatch: () => {
                throw failure;
            },
        });

        try {
            await platform.scheduler.schedule("jobs:run", {}, { delayMs: 0, retry: { maxAttempts: 1 } });
            await reported.promise;

            expect(logged).toHaveBeenCalledWith(expect.stringContaining("scheduled job jobs:run"), failure);
        } finally {
            platform.close();
        }
    });
});
