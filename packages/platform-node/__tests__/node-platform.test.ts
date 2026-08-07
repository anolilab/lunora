import { defineQueue } from "@lunora/queue";
import { describe, expect, it } from "vitest";

import { createNodePlatform } from "../src";

describe("createNodePlatform", () => {
    it("binds the declared queues, and binds nothing when none are declared", async () => {
        expect.hasAssertions();

        const emails = defineQueue({ handler: () => undefined, maxBatchTimeout: 0 });
        const delivered: unknown[] = [];

        using platform = createNodePlatform({
            onQueueBatch: (batch) => {
                for (const message of batch.messages) {
                    delivered.push(message.body);
                }
            },
            queues: { emails },
        });

        // `NODE_CAPABILITIES` rates queues `emulated`, and codegen emits the
        // whole `ctx.queues` surface for anything not rated `unsupported`. A
        // platform that declares the capability and binds nothing is the one
        // combination that fails at runtime with no diagnostic before it.
        expect(platform.capabilities.features.queues?.level).toBe("emulated");

        // Generic over the declared queues, so the binding map keeps its keys —
        // erased to `Record<string, …>` every binding reads as possibly-undefined
        // and the wiring is typed uselessly.
        const queues = platform.queues!;

        expect(queues.env.QUEUE_EMAILS).toBe(queues.bindings.emails);

        await queues.bindings.emails.send({ to: "a@example.com" });
        await queues.poll();

        expect(delivered).toStrictEqual([{ to: "a@example.com" }]);

        // No declarations, nothing to bind — an empty host would suggest
        // `ctx.queues` works when there is no queue to send to.
        using bare = createNodePlatform();

        expect(bare.queues).toBeUndefined();
    });

    it("composes every contract over one in-memory database", async () => {
        expect.assertions(7);

        const platform = createNodePlatform();

        expect(platform.capabilities.id).toBe("node");
        expect(platform.shard).toBeDefined();
        expect(platform.kv).toBeDefined();
        expect(platform.directory).toBeDefined();
        expect(platform.sockets).toBeDefined();
        expect(platform.scheduler).toBeDefined();

        // The four contracts share real state, not four disconnected doubles:
        // a value written through `kv` is readable back, proving `kv` is wired
        // to the same `better-sqlite3` database `shard.sql` runs against.
        await platform.kv.put("k", { hello: "world" });

        await expect(platform.kv.get("k")).resolves.toStrictEqual({ hello: "world" });
    });

    it("threads shardKey and a real database file path through to the shard host", () => {
        expect.assertions(1);

        const platform = createNodePlatform({ shardKey: "tenant-42" });

        expect(platform.shard.shardKey).toBe("tenant-42");
    });
});
