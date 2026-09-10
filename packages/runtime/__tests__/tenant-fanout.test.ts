import { describe, expect, it, vi } from "vitest";

import type { CronHandler, ExecutionContextLike, QueueForwardBatch, QueueForwardHandler } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

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
