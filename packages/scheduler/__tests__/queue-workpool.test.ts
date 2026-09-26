import { getDispatchMessageId, signRequeue } from "@lunora/dispatch";
import { describe, expect, it, vi } from "vitest";

import { createQueueConsumer, createQueueWorkpool, httpDispatcher } from "../src/queue-workpool";
import type { FunctionReference, MessageBatchLike, QueueDispatch, QueueJob, QueueLike, QueueMessageLike, QueueSendOptionsLike } from "../src/types";

const fnRef = (ref: string): FunctionReference<"mutation"> => {
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

    it("threads the queue message id through to the dispatcher", async () => {
        expect.assertions(1);

        const dispatch = vi.fn<QueueDispatch>(async () => undefined);
        const consume = createQueueConsumer({ dispatch });
        const message = fakeMessage({ functionPath: "jobs:a" });

        await consume(fakeBatch([message]));

        expect(dispatch).toHaveBeenCalledWith({ functionPath: "jobs:a" }, "msg-1");
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

    it("retries a DISPATCH_IN_PROGRESS decline after the shard's claim ceiling, not at once into the same decline", async () => {
        expect.assertions(2);

        // A job longer than the dispatch deadline is still running on the shard
        // when its redelivery arrives, and the shard declines it. An immediate
        // retry meets the same claim and spends the queue's budget in seconds.
        const retries: unknown[] = [];
        const message = { ...fakeMessage({ functionPath: "jobs:a" }), retry: (options?: unknown) => retries.push(options) };
        const consume = createQueueConsumer({
            dispatch: httpDispatcher({
                adminToken: "t",
                fetchImpl: async () =>
                    Response.json(
                        { error: { code: "DISPATCH_IN_PROGRESS", message: "already running" } },
                        { headers: { "x-lunora-dispatch-declined": "1" }, status: 409 },
                    ),
                originUrl: "https://app.example.com",
            }),
        });

        await consume(fakeBatch([message]));

        expect(retries).toStrictEqual([{ delaySeconds: 900 }]);
        expect(message.acked).toBe(false);
    });

    it("says so when a decline lands on the message's last delivery", async () => {
        expect.assertions(2);

        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
            const consume = createQueueConsumer({
                dispatch: httpDispatcher({
                    adminToken: "t",
                    fetchImpl: async () =>
                        Response.json(
                            { error: { code: "DISPATCH_IN_PROGRESS", message: "already running" } },
                            { headers: { "x-lunora-dispatch-declined": "1" }, status: 409 },
                        ),
                    originUrl: "https://app.example.com",
                }),
                maxRetries: 1,
            });

            await consume(fakeBatch([{ ...fakeMessage({ functionPath: "jobs:a" }), attempts: 2 }]));

            expect(error).toHaveBeenCalledTimes(1);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/on its last delivery \(attempt 2 of 2\)/u);
        } finally {
            error.mockRestore();
        }
    });

    describe("a decline on the last delivery, with the queue's producer", () => {
        /** Declines every call, recording the dedup id each one carried. */
        const httpDispatcherDeclining = (dedupIds: unknown[] = []): QueueDispatch =>
            httpDispatcher({
                adminToken: "t",
                fetchImpl: async (_url, init) => {
                    dedupIds.push((JSON.parse(init?.body as string) as { id?: unknown }).id);

                    return Response.json(
                        { error: { code: "DISPATCH_IN_PROGRESS", message: "already running" } },
                        { headers: { "x-lunora-dispatch-declined": "1" }, status: 409 },
                    );
                },
                originUrl: "https://app.example.com",
            });

        it("re-enqueues a delayed copy under the original id and acks, instead of letting it drop", async () => {
            expect.assertions(4);

            const queue = fakeQueue();
            const message = fakeMessage({ args: { n: 1 }, functionPath: "jobs:a", shardKey: "s1" });
            const consume = createQueueConsumer({ dispatch: httpDispatcherDeclining(), maxRetries: 0, requeue: { queue, secret: "t" } });

            await consume(fakeBatch([message]));

            // COUNTS: one copy, delayed past the claim, naming the message it replaces under a MAC.
            expect(queue.sent).toStrictEqual([
                {
                    body: {
                        args: { n: 1 },
                        functionPath: "jobs:a",
                        requeuedFrom: "msg-1",
                        requeueMac: await signRequeue("t", "scheduler", "msg-1", JSON.stringify({ args: { n: 1 }, functionPath: "jobs:a", shardKey: "s1" })),
                        shardKey: "s1",
                    },
                    options: { delaySeconds: 900 },
                },
            ]);
            expect(message.acked).toBe(true);
            expect(message.retried).toBe(false);
            expect(queue.send).toHaveBeenCalledTimes(1);
        });

        it("dispatches a genuine copy under the id it replaces, and never re-enqueues a copy", async () => {
            expect.assertions(4);

            const error = vi.spyOn(console, "error").mockImplementation(() => {});

            try {
                const queue = fakeQueue();
                const dedupIds: unknown[] = [];
                const requeueMac = await signRequeue("t", "scheduler", "msg-0", JSON.stringify({ functionPath: "jobs:a" }));
                // The copy's own id is `msg-1`; the message it replaced was `msg-0`.
                const copy = fakeMessage({ functionPath: "jobs:a", requeuedFrom: "msg-0", requeueMac });

                await createQueueConsumer({ dispatch: httpDispatcherDeclining(dedupIds), maxRetries: 0, requeue: { queue, secret: "t" } })(fakeBatch([copy]));

                expect(dedupIds).toStrictEqual(["msg-0"]);
                expect(queue.sent).toStrictEqual([]);
                expect(error).toHaveBeenCalledTimes(1);
                expect(String(error.mock.calls[0]?.[0])).toMatch(/on its last delivery/u);
            } finally {
                error.mockRestore();
            }
        });

        // A body anyone with the producer binding sent by hand must not choose
        // the id its call dedups under — that is how it would be answered with
        // another job's cached result.
        it.each([
            ["no MAC", undefined, "t"],
            ["a forged MAC", "0".repeat(64), "t"],
            ["a MAC under another secret", "other", "t"],
            ["a MAC the consumer has no secret to check", "t", undefined],
        ])("dispatches a job claiming requeuedFrom with %s under the broker's id, marker stripped", async (_label, macSecret, secret) => {
            expect.assertions(1);

            const dispatch = vi.fn<QueueDispatch>(async () => undefined);
            const requeueMac =
                macSecret === undefined || macSecret.length === 64
                    ? macSecret
                    : await signRequeue(macSecret, "scheduler", "victim-1", JSON.stringify({ functionPath: "jobs:a" }));
            const consume = createQueueConsumer({ dispatch, ...(secret === undefined ? {} : { requeue: { queue: fakeQueue(), secret } }) });

            await consume(fakeBatch([fakeMessage({ functionPath: "jobs:a", requeuedFrom: "victim-1", requeueMac })]));

            expect(dispatch.mock.calls).toStrictEqual([[{ functionPath: "jobs:a" }, "msg-1"]]);
        });

        it("falls back to the delayed retry and says why when the send fails", async () => {
            expect.assertions(3);

            const error = vi.spyOn(console, "error").mockImplementation(() => {});

            try {
                const retries: unknown[] = [];
                const queue = {
                    ...fakeQueue(),
                    send: vi.fn<QueueLike<QueueJob>["send"]>(async () => {
                        throw new Error("queue down");
                    }),
                };
                const message = { ...fakeMessage({ functionPath: "jobs:a" }), retry: (options?: unknown) => retries.push(options) };

                await createQueueConsumer({ dispatch: httpDispatcherDeclining(), maxRetries: 0, requeue: { queue, secret: "t" } })(fakeBatch([message]));

                expect(retries).toStrictEqual([{ delaySeconds: 900 }]);
                expect(error).toHaveBeenCalledTimes(1);
                expect(String(error.mock.calls[0]?.[0])).toMatch(/Re-enqueueing a delayed copy failed \(queue down\)/u);
            } finally {
                error.mockRestore();
            }
        });
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

        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example/" });

        await dispatch({ args: { x: 1 }, functionPath: "jobs:a", shardKey: "s1" });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://app.example/_lunora/scheduler/dispatch");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer admintok");
        expect(JSON.parse(init.body as string)).toStrictEqual({ args: { x: 1 }, functionPath: "jobs:a", shardKey: "s1" });
    });

    it("sends the queue message id as the shard dedup id so a redelivery is applied once", async () => {
        expect.assertions(1);

        // Regression: the wire body carried no `id`, so a Queues redelivery after
        // the mutation had already committed re-ran it from scratch (a second
        // charge). The DO-backed path has always deduped via `id: record.id`.
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example/" });

        await dispatch({ args: { x: 1 }, functionPath: "jobs:a" }, "msg-42");

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(JSON.parse(init.body as string)).toStrictEqual({ args: { x: 1 }, functionPath: "jobs:a", id: "msg-42" });
    });

    it("throws on a non-2xx dispatch response so the message retries", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example" });

        await expect(dispatch({ functionPath: "jobs:a" })).rejects.toThrow(/403/u);
    });

    it("stamps the threaded message id onto a dispatch failure for attribution", async () => {
        expect.assertions(1);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("gone", { status: 404 }));
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example" });

        const error: unknown = await dispatch({ functionPath: "jobs:a" }, "msg-42").catch((error_: unknown) => error_);

        expect(getDispatchMessageId(error)).toBe("msg-42");
    });

    // A hanging fetch bound to a SHORT configured deadline. Deliberately driven
    // by the real clock and asserted only through the error the runner throws:
    // the deadline's mechanism is `@lunora/dispatch`'s business (it has moved
    // between `AbortSignal.timeout` and an explicit controller + timer), and a
    // test here that stubs or fake-times that mechanism breaks whenever the
    // runner changes it. What this package owns is that `timeoutMs` reaches the
    // runner and that the resulting failure is retryable — that is what is
    // asserted. The 5-minute default is a constant; proving it fires would mean
    // re-testing the runner's clock from here.
    it("bounds a hung dispatch with the configured deadline and rejects retryable", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
        );
        const dispatch = httpDispatcher({ adminToken: "admintok", fetchImpl: fetchMock, originUrl: "https://app.example", timeoutMs: 20 });

        const error = (await dispatch({ functionPath: "jobs:a" }).catch((error_: unknown) => error_)) as Error & { status?: unknown };

        expect(error.status).toBe(503);
        expect(error.message).toMatch(/timed out after 20ms/u);
    });
});
