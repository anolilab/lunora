import { describe, expect, it, vi } from "vitest";

import { createQueueContext } from "../src/create-queue-context";
import createQueues from "../src/create-queues";
import type { QueueBindingLike } from "../src/types";

const fakeBinding = (): QueueBindingLike & { batches: unknown[]; sends: unknown[] } => {
    const sends: unknown[] = [];
    const batches: unknown[] = [];

    return {
        batches,
        send: vi.fn<(body: unknown, options?: unknown) => Promise<void>>(async (body, options) => {
            sends.push({ body, options });
        }),
        sendBatch: vi.fn<(messages: Iterable<unknown>, options?: unknown) => Promise<void>>(async (messages, options) => {
            batches.push({ messages: [...messages], options });
        }),
        sends,
    };
};

describe("createQueues", () => {
    it("exposes a typed producer per binding", async () => {
        expect.assertions(1);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });

        await queues.emailQueue!.send({ to: "a@b.c" }, { delaySeconds: 30 });

        expect(email.send).toHaveBeenCalledWith({ to: "a@b.c" }, { delaySeconds: 30 });
    });

    it("forwards a batch", async () => {
        expect.assertions(1);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });

        await queues.emailQueue!.sendBatch([{ body: 1 }, { body: 2 }]);

        expect(email.batches[0]).toEqual({ messages: [{ body: 1 }, { body: 2 }], options: undefined });
    });

    it("refuses a delaySeconds over the 12-hour Cloudflare ceiling on send, sendBatch and a batch entry", async () => {
        expect.assertions(4);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });

        // 43_200 is the ceiling itself — accepted.
        await queues.emailQueue!.send({}, { delaySeconds: 43_200 });

        await expect(queues.emailQueue!.send({}, { delaySeconds: 43_201 })).rejects.toThrow(/43201.*ceiling of 43200 \(12 hours\)/su);
        await expect(queues.emailQueue!.sendBatch([{ body: 1 }], { delaySeconds: 64_800 })).rejects.toThrow(/ceiling of 43200/u);
        await expect(queues.emailQueue!.sendBatch([{ body: 1 }, { body: 2, delaySeconds: 86_400 }])).rejects.toThrow(/message 1 delaySeconds is 86400/u);

        expect(email.batches).toHaveLength(0);
    });

    it("throws a directed error for an unknown queue", async () => {
        expect.assertions(1);

        const queues = createQueues({ bindings: { emailQueue: fakeBinding() } });

        await expect(queues.smsQueue!.send({})).rejects.toThrow(/no queue named "smsQueue".*known queues: emailQueue/s);
    });

    it("rejects a sendBatch over the 100-message cap naming the limit and the actual count", async () => {
        expect.assertions(2);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });
        const messages = Array.from({ length: 101 }, (_unused, index) => {
            return { body: index };
        });

        await expect(queues.emailQueue!.sendBatch(messages)).rejects.toThrow(/exceeds 100 \(got 101\)/u);
        expect(email.batches).toHaveLength(0);
    });

    it("the sendBatch cap rejection is async (a rejected promise), not a synchronous throw", async () => {
        expect.assertions(1);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });
        const messages = Array.from({ length: 101 }, (_unused, index) => {
            return { body: index };
        });
        let result: Promise<void> | undefined;

        // Calling sendBatch itself must not throw — the failure only surfaces
        // once the returned promise is awaited/rejected.
        expect(() => {
            result = queues.emailQueue!.sendBatch(messages);
        }).not.toThrow();

        // Consume the (expected) rejection so vitest doesn't flag it as an
        // unhandled rejection once this test completes.
        await result?.catch(() => undefined);
    });

    it("forwards a sendBatch of exactly 100 messages unchanged", async () => {
        expect.assertions(1);

        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });
        const messages = Array.from({ length: 100 }, (_unused, index) => {
            return { body: index };
        });

        await queues.emailQueue!.sendBatch(messages);

        expect((email.batches[0] as { messages: unknown[] }).messages).toHaveLength(100);
    });
});

describe("createQueueContext", () => {
    it("resolves producer bindings from env and skips absent ones", async () => {
        expect.assertions(2);

        const email = fakeBinding();
        const queues = createQueueContext({ QUEUE_EMAIL: email }, [
            { binding: "QUEUE_EMAIL", exportName: "email", name: "email" },
            { binding: "QUEUE_SMS", exportName: "sms", name: "sms" },
        ]);

        await queues.email!.send("hi");

        expect(email.send).toHaveBeenCalledWith("hi", undefined);

        await expect(queues.sms!.send("x")).rejects.toThrow(/no queue named "sms"/);
    });
});
