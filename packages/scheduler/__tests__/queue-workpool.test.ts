import { describe, expect, it, vi } from "vitest";

import { createQueueConsumer, createQueueWorkpool, httpDispatcher } from "../src/queue-workpool";
import type { FunctionReference, MessageBatchLike, QueueJob, QueueLike, QueueMessageLike, QueueSendOptionsLike } from "../src/types";

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

interface SentMessage {
    body: QueueJob;
    options?: QueueSendOptionsLike;
}

const fakeQueue = (): QueueLike<QueueJob> & { batches: QueueJob[][]; sent: SentMessage[] } => {
    const sent: SentMessage[] = [];
    const batches: QueueJob[][] = [];

    return {
        batches,
        send: vi.fn<QueueLike<QueueJob>["send"]>(async (body, options) => {
            sent.push({ body, options });
        }),
        sendBatch: vi.fn<QueueLike<QueueJob>["sendBatch"]>(async (messages) => {
            batches.push([...messages].map((message) => message.body));
        }),
        sent,
    };
};

/** A consumer message whose ack/retry calls are recorded. */
const fakeMessage = (body: unknown): QueueMessageLike & { acked: boolean; retried: boolean } => {
    const state = { acked: false, retried: false };

    return {
        ack: () => {
            state.acked = true;
        },
        get acked() {
            return state.acked;
        },
        attempts: 1,
        body,
        id: "msg-1",
        retry: () => {
            state.retried = true;
        },
        get retried() {
            return state.retried;
        },
        timestamp: new Date(0),
    };
};

const fakeBatch = (messages: ReadonlyArray<QueueMessageLike>): MessageBatchLike => {
    return {
        ackAll: () => undefined,
        messages,
        queue: "jobs",
        retryAll: () => undefined,
    };
};

describe("createQueueWorkpool", () => {
    it("enqueues a QueueJob with functionPath, args, and shardKey", async () => {
        expect.assertions(2);

        const queue = fakeQueue();
        const pool = createQueueWorkpool({ queue });

        await pool.enqueue(fnRef("stripe:sync"), { invoiceId: "in_1" }, { shardKey: "tenant-7" });

        expect(queue.sent).toHaveLength(1);
        expect(queue.sent[0]?.body).toStrictEqual({ args: { invoiceId: "in_1" }, functionPath: "stripe:sync", shardKey: "tenant-7" });
    });

    it("forwards delaySeconds as the send option", async () => {
        expect.assertions(1);

        const queue = fakeQueue();
        const pool = createQueueWorkpool({ queue });

        await pool.enqueue(fnRef("cleanup:run"), {}, { delaySeconds: 30 });

        expect(queue.sent[0]?.options).toStrictEqual({ delaySeconds: 30 });
    });

    it("enqueues a batch in one sendBatch call", async () => {
        expect.assertions(2);

        const queue = fakeQueue();
        const pool = createQueueWorkpool({ queue });

        await pool.enqueueBatch([
            { args: { id: "a" }, ref: fnRef("jobs:a") },
            { ref: fnRef("jobs:b"), shardKey: "s2" },
        ]);

        expect(queue.batches).toHaveLength(1);
        expect(queue.batches[0]).toStrictEqual([
            { args: { id: "a" }, functionPath: "jobs:a", shardKey: undefined },
            { args: undefined, functionPath: "jobs:b", shardKey: "s2" },
        ]);
    });

    it("throws when no queue binding is provided", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the JS-caller guard
        expect(() => createQueueWorkpool({})).toThrow(/queue/u);
    });

    it("rejects an enqueueBatch over the 100-message cap naming the limit and the actual count", async () => {
        expect.assertions(2);

        const queue = fakeQueue();
        const pool = createQueueWorkpool({ queue });
        const jobs = Array.from({ length: 101 }, (_unused, index) => {
            return { ref: fnRef(`jobs:${String(index)}`) };
        });

        await expect(pool.enqueueBatch(jobs)).rejects.toThrow(/exceeds 100 \(got 101\)/u);
        expect(queue.batches).toHaveLength(0);
    });

    it("passes an enqueueBatch of exactly 100 jobs through to the binding unchanged", async () => {
        expect.assertions(2);

        const queue = fakeQueue();
        const pool = createQueueWorkpool({ queue });
        const jobs = Array.from({ length: 100 }, (_unused, index) => {
            return { ref: fnRef(`jobs:${String(index)}`) };
        });

        await pool.enqueueBatch(jobs);

        expect(queue.batches).toHaveLength(1);
        expect(queue.batches[0]).toHaveLength(100);
    });
});

describe("createQueueConsumer", () => {
    it("dispatches each message and acks on success", async () => {
        expect.assertions(3);

        const dispatched: QueueJob[] = [];
        const consume = createQueueConsumer({
            dispatch: async (job) => {
                dispatched.push(job);
            },
        });

        const message = fakeMessage({ args: {}, functionPath: "jobs:a" });

        await consume(fakeBatch([message]));

        expect(dispatched).toHaveLength(1);
        expect(message.acked).toBe(true);
        expect(message.retried).toBe(false);
    });

    it("retries a message when the dispatcher throws", async () => {
        expect.assertions(2);

        const consume = createQueueConsumer({
            dispatch: async () => {
                throw new Error("downstream 500");
            },
        });

        const message = fakeMessage({ functionPath: "jobs:a" });

        await consume(fakeBatch([message]));

        expect(message.retried).toBe(true);
        expect(message.acked).toBe(false);
    });

    it("retries a structurally-invalid message (no functionPath) so it dead-letters", async () => {
        expect.assertions(2);

        const dispatch = vi.fn<(job: QueueJob) => Promise<void>>(async () => undefined);
        const consume = createQueueConsumer({ dispatch });

        const message = fakeMessage({ notAJob: true });

        await consume(fakeBatch([message]));

        expect(message.retried).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe("httpDispatcher", () => {
    it("pOSTs the job to the scheduler dispatch endpoint with the admin bearer", async () => {
        expect.assertions(4);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example/" });

        await dispatch({ args: { x: 1 }, functionPath: "jobs:a", shardKey: "s1" });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example/_lunora/scheduler/dispatch");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer admintok");
        expect(JSON.parse(init.body as string)).toStrictEqual({ args: { x: 1 }, functionPath: "jobs:a", shardKey: "s1" });
    });

    it("throws on a non-2xx dispatch response so the message retries", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example" });

        await expect(dispatch({ functionPath: "jobs:a" })).rejects.toThrow(/403/u);
    });
});
