import { describe, expect, it, vi } from "vitest";

import { defineQueue } from "../src/define-queue";
import type { QueueRegistry } from "../src/dispatch";
import { dispatchForwardedQueueBatch } from "../src/forward";

/**
 * A Workers-for-Platforms tenant receives its queue batches over `POST
 * /_lunora/queue`, named after the platform's per-binding queue rather than the
 * queue the app declared. These run that path through the real dispatch.
 */
const registryOf = (handler: Parameters<typeof defineQueue>[0]["handler"]): QueueRegistry => {
    return { "email-jobs": { binding: "QUEUE_EMAIL", definition: defineQueue({ handler }), exportName: "emailJobs" } };
};

describe(dispatchForwardedQueueBatch, () => {
    it("routes a batch forwarded under the binding to the declared queue whose name differs", async () => {
        expect.assertions(2);

        const seen: unknown[] = [];
        const registry = registryOf((_context, batch) => {
            for (const message of batch.messages) {
                seen.push(message.body);
            }
        });

        const result = await dispatchForwardedQueueBatch({ messages: [{ body: { to: "a" }, id: "m1" }], queue: "queue-email" }, registry, { env: {} });

        expect(seen).toStrictEqual([{ to: "a" }]);
        expect(result).toStrictEqual({ retry: [] });
    });

    it("hands the handler the platform's delivery attempt, so a last delivery is seen as one", async () => {
        expect.assertions(1);

        const attempts: number[] = [];
        const registry = registryOf((_context, batch) => {
            for (const message of batch.messages) {
                attempts.push(message.attempts);
            }
        });

        await dispatchForwardedQueueBatch(
            {
                messages: [
                    { attempts: 4, body: "last", id: "m1" },
                    { body: "first", id: "m2" },
                ],
                queue: "queue-email",
            },
            registry,
            { env: {} },
        );

        expect(attempts).toStrictEqual([4, 1]);
    });

    it("still routes a batch forwarded under the declared name", async () => {
        expect.assertions(1);

        const handler = vi.fn<() => void>();

        await dispatchForwardedQueueBatch({ messages: [{ body: 1, id: "m1" }], queue: "email-jobs" }, registryOf(handler), { env: {} });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("answers the ids the handler retried", async () => {
        expect.assertions(1);

        const registry = registryOf((_context, batch) => {
            for (const message of batch.messages) {
                if (message.body === "bad") {
                    message.retry();
                } else {
                    message.ack();
                }
            }
        });

        const result = await dispatchForwardedQueueBatch(
            {
                messages: [
                    { body: "ok", id: "m1" },
                    { body: "bad", id: "m2" },
                ],
                queue: "queue-email",
            },
            registry,
            { env: {} },
        );

        expect(result).toStrictEqual({ retry: ["m2"] });
    });

    it("answers the delay each retry asked for, so the platform does not redeliver it at once", async () => {
        expect.assertions(1);

        const registry = registryOf((_context, batch) => {
            const [first, second, third] = batch.messages;

            first?.retry({ delaySeconds: 30 });
            second?.retry();
            third?.retry({ delaySeconds: 60 });
            third?.ack();
        });

        const result = await dispatchForwardedQueueBatch(
            {
                messages: [
                    { body: 1, id: "m1" },
                    { body: 2, id: "m2" },
                    { body: 3, id: "m3" },
                ],
                queue: "queue-email",
            },
            registry,
            { env: {} },
        );

        expect(result).toStrictEqual({ retry: ["m1", "m2"], retryDelays: { m1: 30 } });
    });

    it("answers retryAll's delay for every message", async () => {
        expect.assertions(1);

        const registry = registryOf((_context, batch) => {
            batch.retryAll({ delaySeconds: 45 });
        });

        const result = await dispatchForwardedQueueBatch(
            {
                messages: [
                    { body: 1, id: "m1" },
                    { body: 2, id: "m2" },
                ],
                queue: "queue-email",
            },
            registry,
            { env: {} },
        );

        expect(result).toStrictEqual({ retry: ["m1", "m2"], retryDelays: { m1: 45, m2: 45 } });
    });

    it("retries every unacked message when the handler fails the batch", async () => {
        expect.assertions(1);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const registry = registryOf((_context, batch) => {
            batch.messages[0]?.ack();

            throw new Error("boom");
        });

        const result = await dispatchForwardedQueueBatch(
            {
                messages: [
                    { body: 1, id: "m1" },
                    { body: 2, id: "m2" },
                ],
                queue: "queue-email",
            },
            registry,
            { env: {} },
        );

        error.mockRestore();

        expect(result).toStrictEqual({ retry: ["m2"] });
    });

    it("holds a paused tenant's batch as acked copies, so the platform spends no delivery attempt", async () => {
        expect.assertions(3);

        const handler = vi.fn<() => void>();
        const send = vi.fn<(body: unknown, options?: unknown) => Promise<void>>(async () => undefined);

        const result = await dispatchForwardedQueueBatch(
            { messages: [{ attempts: 3, body: { to: "a" }, id: "m1" }], queue: "queue-email" },
            registryOf(handler),
            {
                env: { LUNORA_ADMIN_TOKEN: "tok", QUEUE_EMAIL: { send } },
                holdSeconds: 300,
            },
        );

        expect(send).toHaveBeenCalledWith(expect.anything(), { contentType: "json", delaySeconds: 300 });
        // Nothing to retry: a retry, however delayed, is one of the platform's attempts.
        expect(result).toStrictEqual({ retry: [] });
        expect(handler).not.toHaveBeenCalled();
    });
});
