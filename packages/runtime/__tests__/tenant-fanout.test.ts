import { describe, expect, it, vi } from "vitest";

import type { CronHandler, ExecutionContextLike, QueueForwardBatch, QueueForwardHandler } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import chunkedBody from "./helpers/chunked-body";

/**
 * The two reserved fan-out endpoints a Workers-for-Platforms tenant depends on.
 *
 * A namespaced Worker gets neither `triggers.crons` nor a queue consumer of its
 * own, so the control plane drives both over HTTP instead: `POST
 * /_lunora/scheduled` replays a cron firing, `POST /_lunora/queue` hands over a
 * batch the platform consumer drained. Both are admin-gated, and both are the
 * only path by which a tenant's scheduled and queue work runs at all — a
 * regression here is silent, because nothing else calls them.
 */

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const SCHEDULED_PATH = "https://tenant.example/_lunora/scheduled";
const QUEUE_PATH = "https://tenant.example/_lunora/queue";

const shardNamespace = (): ShardNamespaceLike => {
    return {
        get: () => {
            return { fetch: async () => Response.json({ result: null }) };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

/** A POST carrying the admin bearer, unless `authorized` says otherwise. */
const post = (url: string, body: unknown, authorized = true): Request =>
    new Request(url, {
        body: JSON.stringify(body),
        headers: authorized ? { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" } : { "content-type": "application/json" },
        method: "POST",
    });

describe("createWorker — the tenant cron fan-out endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(2);

        const crons = { "*/5 * * * *": vi.fn<CronHandler>() };
        const worker = createWorker({ adminToken: ADMIN_TOKEN, crons, shardDO: shardNamespace() });

        const response = await worker.fetch(post(SCHEDULED_PATH, { cron: "*/5 * * * *" }, false), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(crons["*/5 * * * *"]).not.toHaveBeenCalled();
    });

    it("dispatches the handler whose key equals the replayed expression", async () => {
        expect.assertions(3);

        const matched = vi.fn<CronHandler>();
        const other = vi.fn<CronHandler>();
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            crons: { "*/5 * * * *": matched, "0 9 * * *": other },
            shardDO: shardNamespace(),
        });

        const response = await worker.fetch(post(SCHEDULED_PATH, { cron: "*/5 * * * *" }), {}, fakeContext);

        await expect(response.json()).resolves.toStrictEqual({ cron: "*/5 * * * *", ok: true });
        expect(matched).toHaveBeenCalledTimes(1);
        // Keyed dispatch, not "run every cron": a tick for one expression must
        // not fire the tenant's other jobs.
        expect(other).not.toHaveBeenCalled();
    });

    it("refuses a tick that names no expression (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, crons: { "*/5 * * * *": vi.fn<CronHandler>() }, shardDO: shardNamespace() });

        const response = await worker.fetch(post(SCHEDULED_PATH, {}), {}, fakeContext);

        expect(response.status).toBe(400);
    });

    it("refuses a JSON `null` root with the tick's own 400, not a 500", async () => {
        expect.assertions(2);

        const cron = vi.fn<CronHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, crons: { "*/5 * * * *": cron }, shardDO: shardNamespace() });

        // `readLooseJsonBody` can only return `{}`, a parsed value, or throw —
        // but `null` IS a parsed value, so a handler that reads a property off
        // the result without guarding turns a malformed tick into a 500.
        const response = await worker.fetch(post(SCHEDULED_PATH, null), {}, fakeContext);

        expect(response.status).toBe(400);
        expect(cron).not.toHaveBeenCalled();
    });

    it("refuses a GET (405), so the endpoint cannot be triggered by a link", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, crons: { "*/5 * * * *": vi.fn<CronHandler>() }, shardDO: shardNamespace() });

        const response = await worker.fetch(new Request(SCHEDULED_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), {}, fakeContext);

        expect(response.status).toBe(405);
    });
});

describe("createWorker — the tenant queue fan-out endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(2);

        const queueHandler = vi.fn<QueueForwardHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, shardDO: shardNamespace() });

        const response = await worker.fetch(post(QUEUE_PATH, { messages: [], queue: "jobs" }, false), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(queueHandler).not.toHaveBeenCalled();
    });

    it("forwards the batch and reports back only the ids to retry", async () => {
        expect.assertions(2);

        const seen: QueueForwardBatch[] = [];
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queueHandler: (batch) => {
                seen.push(batch);

                return { retry: ["m2"] };
            },
            shardDO: shardNamespace(),
        });

        const response = await worker.fetch(
            post(QUEUE_PATH, {
                messages: [
                    { body: { a: 1 }, id: "m1" },
                    { body: { a: 2 }, id: "m2" },
                ],
                queue: "jobs",
            }),
            {},
            fakeContext,
        );

        await expect(response.json()).resolves.toStrictEqual({ retry: ["m2"] });
        expect(seen).toStrictEqual([
            {
                messages: [
                    { body: { a: 1 }, id: "m1" },
                    { body: { a: 2 }, id: "m2" },
                ],
                queue: "jobs",
            },
        ]);
    });

    it("answers an empty retry list when the handler returns nothing", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler: () => undefined, shardDO: shardNamespace() });

        const response = await worker.fetch(post(QUEUE_PATH, { messages: [{ body: 1, id: "m1" }], queue: "jobs" }), {}, fakeContext);

        await expect(response.json()).resolves.toStrictEqual({ retry: [] });
    });

    it("drops a message with no string id rather than handing the handler a batch it cannot ack", async () => {
        expect.assertions(1);

        const seen: QueueForwardBatch[] = [];
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queueHandler: (batch) => {
                seen.push(batch);
            },
            shardDO: shardNamespace(),
        });

        await worker.fetch(post(QUEUE_PATH, { messages: [{ body: 1, id: "m1" }, { body: 2 }, "junk"], queue: "jobs" }), {}, fakeContext);

        expect(seen[0]?.messages).toStrictEqual([{ body: 1, id: "m1" }]);
    });

    it("refuses the endpoint outright when the app wired no queueHandler (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: shardNamespace() });

        const response = await worker.fetch(post(QUEUE_PATH, { messages: [], queue: "jobs" }), {}, fakeContext);

        expect(response.status).toBe(400);
    });
});

/**
 * A `{"retry": []}` answer tells the platform consumer every message in the
 * batch was handled, so it deletes them. A body this endpoint could not read
 * must therefore never reach that answer: a request that names no batch has to
 * fail loudly, or a forwarder that writes no body — or a proxy that strips one —
 * silently destroys every message it was carrying, with a 200 to say it went
 * fine. Cloudflare Queues never delivers an empty batch, so an explicit
 * `messages: []` stays a legal (if pointless) request.
 */
describe("createWorker — a queue dispatch that names no batch", () => {
    const refusedBodies: [label: string, body: unknown][] = [
        ["a JSON null root", null],
        ["an array root", []],
        ["a string root", "jobs"],
        ["a number root", 123],
        ["an object with no `messages`", { queue: "jobs" }],
        ["a `messages` that is not an array", { messages: "m1", queue: "jobs" }],
    ];

    it.each(refusedBodies)("refuses %s (400) rather than acking a batch it never read", async (_label, body) => {
        expect.assertions(2);

        const queueHandler = vi.fn<QueueForwardHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, shardDO: shardNamespace() });

        const response = await worker.fetch(post(QUEUE_PATH, body), {}, fakeContext);

        expect(response.status).toBe(400);
        expect(queueHandler).not.toHaveBeenCalled();
    });

    it("refuses a POST with no body at all (400)", async () => {
        expect.assertions(2);

        const queueHandler = vi.fn<QueueForwardHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, shardDO: shardNamespace() });

        // The likeliest real trigger: a forwarder that fails to write a body, or
        // a proxy that strips it. `readLooseJsonBody` maps an empty body to `{}`,
        // so nothing upstream of the guard distinguishes it from a real batch.
        const response = await worker.fetch(new Request(QUEUE_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(400);
        expect(queueHandler).not.toHaveBeenCalled();
    });

    it("still accepts an explicit empty batch", async () => {
        expect.assertions(2);

        const queueHandler = vi.fn<QueueForwardHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, shardDO: shardNamespace() });

        const response = await worker.fetch(post(QUEUE_PATH, { messages: [], queue: "jobs" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(queueHandler).toHaveBeenCalledTimes(1);
    });
});

/**
 * Both endpoints take an admin-supplied JSON body, so both need the byte budget
 * the rest of the reserved surface reads under. `Content-Length` is forgeable
 * and absent on a chunked body, so the entry-point header check is a fast path,
 * not the cap — only a reader counting bytes as they arrive is. And the cap the
 * reader applies has to be the one the header check applies, or an identical
 * batch is accepted or rejected depending on how the platform consumer framed it.
 */
describe("createWorker — the fan-out endpoints' body budget", () => {
    /** POST a chunked (length-less) body carrying the admin bearer. */
    const postChunked = (url: string, body: ReadableStream<Uint8Array>): Request =>
        new Request(url, {
            body,
            // @ts-expect-error -- duplex is required by the fetch spec for a streaming body but missing from the lib types here
            duplex: "half",
            headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
            method: "POST",
        });

    it("rejects an oversized chunked cron tick at the reader, not only at the Content-Length header (413)", async () => {
        expect.assertions(2);

        const cron = vi.fn<CronHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, crons: { "*/5 * * * *": cron }, shardDO: shardNamespace() });

        const response = await worker.fetch(
            postChunked(SCHEDULED_PATH, chunkedBody({ exceedBytes: 1_048_576, prefix: String.raw`{"cron":"*/5 * * * *","pad":"`, suffix: `"}` })),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
        // The tick must be refused before it fires, not after the oversized body
        // has been buffered in full and dispatched.
        expect(cron).not.toHaveBeenCalled();
    });

    it("rejects a chunked queue batch over the route's own budget (413)", async () => {
        expect.assertions(2);

        const queueHandler = vi.fn<QueueForwardHandler>();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, shardDO: shardNamespace() });

        const response = await worker.fetch(
            postChunked(QUEUE_PATH, chunkedBody({ exceedBytes: 16 * 1_048_576, prefix: String.raw`{"queue":"jobs","messages":[],"pad":"`, suffix: `"}` })),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
        expect(queueHandler).not.toHaveBeenCalled();
    });

    it("accepts a forwarded batch above the shared 1 MiB JSON cap", async () => {
        expect.assertions(3);

        const seen: QueueForwardBatch[] = [];
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queueHandler: (batch) => {
                seen.push(batch);
            },
            shardDO: shardNamespace(),
        });

        // 2 MiB of message bodies: a fraction of what a full 100 × 128 KiB batch
        // weighs, and over the shared 1 MiB cap this endpoint used to inherit.
        const messages = Array.from({ length: 16 }, (_, index) => {
            return { body: "x".repeat(128 * 1024), id: `m${String(index)}` };
        });
        const body = JSON.stringify({ messages, queue: "jobs" });

        // Declared explicitly: a real forwarded POST carries a `Content-Length`,
        // and it is the entry-point header check — not the reader — that a batch
        // over the shared cap used to die on. `Request` does not synthesize the
        // header, so without it this asserts only half the path.
        const response = await worker.fetch(
            new Request(QUEUE_PATH, {
                body,
                headers: {
                    authorization: `Bearer ${ADMIN_TOKEN}`,
                    "content-length": String(new TextEncoder().encode(body).byteLength),
                    "content-type": "application/json",
                },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ retry: [] });
        expect(seen[0]?.messages).toHaveLength(16);
    });
});
