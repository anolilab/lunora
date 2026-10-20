import { describe, expect, it, vi } from "vitest";

import { defineQueue } from "../src/define-queue";
import { dispatchQueueBatch } from "../src/dispatch";
import type { MessageBatchLike, MessageLike } from "../src/types";

/**
 * `ctx.live.publish` on a `defineQueue` handler. A queue consumer runs in the
 * Worker, not in a shard, so it cannot publish in-process: the runtime hands the
 * dispatcher a publisher that forwards to the shard, and the handler sees it as
 * `ctx.live`. When the runtime supplies none, `ctx.live` is absent rather than a
 * stub that would publish to nothing.
 */

const message = <Body>(body: Body): MessageLike<Body> => {
    return {
        ack: vi.fn<() => void>(),
        attempts: 1,
        body,
        id: "m1",
        retry: vi.fn<() => void>(),
        timestamp: new Date(0),
    };
};

const batch = <Body>(queue: string, messages: MessageLike<Body>[]): MessageBatchLike<Body> => {
    return {
        ackAll: vi.fn<() => void>(),
        messages,
        queue,
        retryAll: vi.fn<() => void>(),
    };
};

describe("queue ctx.live.publish", () => {
    it("hands the handler the runtime's publisher, so a publish reaches the shard it forwards to", async () => {
        expect.assertions(2);

        const published: unknown[] = [];
        const q = defineQueue<{ postId: string }>({
            handler: async (context, b) => {
                await Promise.all(
                    b.messages.map(async (m) => {
                        await context.live?.publish({ __lunoraLive: "posts", topic: `post:${m.body.postId}` }, { event: "digest_ready" });
                        m.ack();
                    }),
                );
            },
        });

        await dispatchQueueBatch(
            batch("digest", [message({ postId: "1" })]),
            { digest: { definition: q, exportName: "digest" } },
            {
                env: {},
                live: {
                    publish: async (topic, payload, options) => {
                        published.push({ options, payload, topic });
                    },
                },
            },
        );

        expect(published).toHaveLength(1);
        expect(published[0]).toEqual({ options: undefined, payload: { event: "digest_ready" }, topic: { __lunoraLive: "posts", topic: "post:1" } });
    });

    it("leaves ctx.live absent when the runtime supplies no publisher", async () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const q = defineQueue({
            handler: (context, b) => {
                seen.push(context.live);

                for (const m of b.messages) {
                    m.ack();
                }
            },
        });

        await dispatchQueueBatch(batch("q", [message({})]), { q: { definition: q, exportName: "q" } }, { env: {} });

        expect(seen).toEqual([undefined]);
    });
});
