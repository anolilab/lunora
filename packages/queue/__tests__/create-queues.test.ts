import { describe, expect, it, vi } from "vitest";

import { createQueueContext } from "../src/create-queue-context";
import createQueues from "../src/create-queues";
import type { QueueBindingLike } from "../src/types";

const fakeBinding = (): QueueBindingLike & { batches: unknown[]; sends: unknown[] } => {
    const sends: unknown[] = [];
    const batches: unknown[] = [];

    return {
        batches,
        send: vi.fn(async (body: unknown, options?: unknown) => {
            sends.push({ body, options });
        }),
        sendBatch: vi.fn(async (messages: Iterable<unknown>, options?: unknown) => {
            batches.push({ messages: [...messages], options });
        }),
        sends,
    };
};

describe("createQueues", () => {
    it("exposes a typed producer per binding", async () => {
        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });

        await queues.emailQueue!.send({ to: "a@b.c" }, { delaySeconds: 30 });

        expect(email.send).toHaveBeenCalledWith({ to: "a@b.c" }, { delaySeconds: 30 });
    });

    it("forwards a batch", async () => {
        const email = fakeBinding();
        const queues = createQueues({ bindings: { emailQueue: email } });

        await queues.emailQueue!.sendBatch([{ body: 1 }, { body: 2 }]);

        expect(email.batches[0]).toEqual({ messages: [{ body: 1 }, { body: 2 }], options: undefined });
    });

    it("throws a directed error for an unknown queue", async () => {
        const queues = createQueues({ bindings: { emailQueue: fakeBinding() } });

        await expect(queues.smsQueue!.send({})).rejects.toThrow(/no queue named "smsQueue".*known queues: emailQueue/s);
    });
});

describe("createQueueContext", () => {
    it("resolves producer bindings from env and skips absent ones", async () => {
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
