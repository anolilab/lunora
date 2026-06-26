import { describe, expect, it, vi } from "vitest";

import { defineQueue } from "../src/define-queue";
import { dispatchQueueBatch } from "../src/dispatch";
import type { MessageBatchLike, MessageLike } from "../src/types";

const message = <Body>(body: Body): MessageLike<Body> & { acked: boolean } => {
    const m = {
        ack: vi.fn(() => {
            m.acked = true;
        }),
        acked: false,
        attempts: 1,
        body,
        id: "m1",
        retry: vi.fn(),
        timestamp: new Date(0),
    };

    return m;
};

const batch = <Body>(queue: string, messages: MessageLike<Body>[]): MessageBatchLike<Body> => {
    return {
        ackAll: vi.fn(),
        messages,
        queue,
        retryAll: vi.fn(),
    };
};

describe("dispatchQueueBatch", () => {
    it("routes a batch to the matching push handler and runs it", async () => {
        const seen: unknown[] = [];
        const emailQueue = defineQueue<{ to: string }>({
            handler: (context, b) => {
                for (const m of b.messages) {
                    seen.push(m.body);
                    m.ack();
                }

                context.log.info("processed");
            },
        });

        const m = message({ to: "x@y.z" });
        await dispatchQueueBatch(batch("email-queue", [m]), { "email-queue": { definition: emailQueue, exportName: "emailQueue" } }, { env: {} });

        expect(seen).toEqual([{ to: "x@y.z" }]);
        expect(m.acked).toBe(true);
    });

    it("throws when no handler is registered for the delivered queue", async () => {
        await expect(dispatchQueueBatch(batch("ghost", []), {}, { env: {} })).rejects.toThrow(/no push handler is registered/);
    });

    it("throws for a pull-declared queue with no handler", async () => {
        const pull = defineQueue({ mode: "pull" });

        await expect(dispatchQueueBatch(batch("p", []), { p: { definition: pull, exportName: "p" } }, { env: {} })).rejects.toThrow(/pull consumer/);
    });
});
