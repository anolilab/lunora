/**
 * The queue workpool's args wire: `enqueue`/`enqueueBatch` put a `QueueJob` on
 * the queue, `httpDispatcher` POSTs it to `/_lunora/scheduler/dispatch`, and the
 * shard's dispatch loop is the one and only decoder
 * (`decodeWire(payload.args ?? {})`, `@lunora/do`'s `shard-do`). These pin the
 * producer half of that bracket: a `bigint` or `Date` argument has to reach the
 * handler as a `bigint` or `Date`, and a pure-JSON argument has to be unchanged
 * byte for byte.
 */
import { describe, expect, it } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import { createQueueWorkpool, httpDispatcher } from "../src/queue-workpool";
import type { FunctionReference, QueueJob, QueueLike, QueueSendRequestLike } from "../src/types";

const fnRef = (ref: string): FunctionReference<"mutation"> => {
    return { __lunoraRef: ref };
};

/**
 * How a queue binding serialises a message body. `json` is what
 * `@lunora/platform-node`'s queue host defaults to (`sendOptions?.contentType ?? "json"`)
 * and `v8` is Cloudflare's own default, so a job's args must survive both: JSON
 * refuses a `bigint` outright and flattens a `Date`, while structured clone
 * carries values the next hop's `JSON.stringify` then refuses instead.
 */
const TRANSPORTS: Record<string, (body: QueueJob) => QueueJob> = {
    json: (body) => {
        // Deliberately the store-and-forward round trip through a string that
        // `@lunora/platform-node`'s `encodeBody`/`decodeBody` perform, NOT a deep
        // clone: refusing a `bigint` and flattening a `Date` is the behaviour
        // under test.
        const stored = JSON.stringify(body);

        return JSON.parse(stored) as QueueJob;
    },
    v8: (body) => structuredClone(body),
};

/** Collects what the queue binding was handed, serialised the way the transport would. */
const recordingQueue = (transport: (body: QueueJob) => QueueJob): QueueLike<QueueJob> & { delivered: QueueJob[] } => {
    const delivered: QueueJob[] = [];

    return {
        delivered,
        send: async (body: QueueJob) => {
            delivered.push(transport(body));
        },
        sendBatch: async (messages: Iterable<QueueSendRequestLike<QueueJob>>) => {
            for (const message of messages) {
                delivered.push(transport(message.body));
            }
        },
    };
};

/**
 * Run one delivered job through `httpDispatcher` and return the `args` it POSTed
 * to `/_lunora/scheduler/dispatch`, still in wire form — the shard's single
 * `decodeWire` has not run yet. `createQueueConsumer` is deliberately not in the
 * way: it passes `message.body` to the dispatcher verbatim (pinned by
 * `queue-workpool.test.ts`), and calling the dispatcher directly lets a producer
 * failure surface as itself rather than as a swallowed `retry()`.
 */
const dispatchedWireArgs = async (job: QueueJob): Promise<unknown> => {
    let body = "";

    const dispatch = httpDispatcher({
        adminToken: "admintok",
        fetchImpl: async (_url: unknown, init?: RequestInit) => {
            body = init?.body as string;

            return new Response(null, { status: 200 });
        },
        originUrl: "https://app.example",
    });

    await dispatch(job, "msg-1");

    return (JSON.parse(body) as { args?: unknown }).args ?? {};
};

/** What the shard's dispatch loop would hand the handler for one delivered job. */
const dispatchToHandlerArgs = async (job: QueueJob): Promise<Record<string, unknown>> => decodeWire(await dispatchedWireArgs(job)) as Record<string, unknown>;

describe.each(Object.entries(TRANSPORTS))("queue workpool args wire over a %s queue", (_name, transport) => {
    it("delivers a bigint argument to the handler as a bigint", async () => {
        expect.assertions(2);

        const queue = recordingQueue(transport);

        await createQueueWorkpool({ queue }).enqueue(fnRef("jobs:charge"), { amountCents: 4_294_967_296n });

        const args = await dispatchToHandlerArgs(queue.delivered[0] as QueueJob);

        expect(typeof args["amountCents"]).toBe("bigint");
        expect(args["amountCents"]).toBe(4_294_967_296n);
    });

    it("delivers a Date argument to the handler as a Date", async () => {
        expect.assertions(2);

        const queue = recordingQueue(transport);

        await createQueueWorkpool({ queue }).enqueue(fnRef("jobs:remind"), { dueAt: new Date("2026-06-01T12:00:00.000Z") });

        const args = await dispatchToHandlerArgs(queue.delivered[0] as QueueJob);

        // The type, not merely the absence of a throw: an un-encoded `Date`
        // arrives as an ISO string, which fails nothing until the handler does
        // date arithmetic on it.
        expect(args["dueAt"]).toBeInstanceOf(Date);
        expect((args["dueAt"] as Date).toISOString()).toBe("2026-06-01T12:00:00.000Z");
    });

    it("delivers an enqueueBatch job's bigint argument to the handler as a bigint", async () => {
        expect.assertions(1);

        const queue = recordingQueue(transport);

        await createQueueWorkpool({ queue }).enqueueBatch([{ args: { amountCents: 7n }, ref: fnRef("jobs:charge") }]);

        const args = await dispatchToHandlerArgs(queue.delivered[0] as QueueJob);

        expect(args["amountCents"]).toBe(7n);
    });

    it("leaves pure-JSON args untouched on the wire and at the handler", async () => {
        expect.assertions(2);

        const plain = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null }, note: "hi" };
        const queue = recordingQueue(transport);

        await createQueueWorkpool({ queue }).enqueue(fnRef("jobs:report"), plain);

        // Identity on the queue itself: nothing was tagged, so an existing
        // caller's message body is byte for byte what it always was.
        expect(queue.delivered[0]?.args).toStrictEqual(plain);

        const args = await dispatchToHandlerArgs(queue.delivered[0] as QueueJob);

        expect(args).toStrictEqual(plain);
    });

    it("hands the queued args to the dispatch endpoint unchanged, so the shard decodes exactly once", async () => {
        expect.assertions(1);

        // The no-double-encode pin. `createDispatchRunner` encodes `args` for
        // every OTHER producer (`ctx.run` in a workflow body / queue handler,
        // the agent loop's and voice session's dispatchers), and this path is
        // the one that must opt out (`argsAlreadyEncoded`) because `enqueue`
        // already encoded before the queue's own `JSON.stringify`. Asserting the
        // POST body's `args` are byte-identical to the queued job's is what
        // fails if that opt-out is ever dropped — the handler-facing assertions
        // above catch the `bigint`, but a double-encoded `Date` decodes to `{}`
        // and only a shape check names the cause.
        const queue = recordingQueue(transport);

        await createQueueWorkpool({ queue }).enqueue(fnRef("jobs:remind"), { amountCents: 7n, dueAt: new Date("2026-06-01T12:00:00.000Z") });

        const job = queue.delivered[0] as QueueJob;

        await expect(dispatchedWireArgs(job)).resolves.toStrictEqual(job.args);
    });
});
