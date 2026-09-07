import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const RUN_PATH = "https://app.example/_lunora/admin/cron-jobs/run";

interface ShardSpy {
    calls: { body: unknown; shardKey: string }[];
    namespace: ShardNamespaceLike;
    response: Response;
}

const createShardSpy = (response = new Response("ok", { status: 200 })): ShardSpy => {
    const calls: { body: unknown; shardKey: string }[] = [];
    const spy = { calls, response } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    calls.push({ body: await request.clone().json(), shardKey });

                    return spy.response;
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const CRON_JOBS = {
    "*/5 * * * *": [{ args: { tenant: "acme" }, functionPath: "presence:clear", name: "clear presence", shardKey: "acme" }],
    "0 9 * * *": [{ args: { region: "eu" }, name: "nightly digest", workflow: "WORKFLOW_DIGEST" }],
};

const runRequest = (name: string): Request =>
    new Request(RUN_PATH, {
        body: JSON.stringify({ name }),
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        method: "POST",
    });

describe("createWorker — cron-jobs run endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: createShardSpy().namespace });

        const response = await worker.fetch(new Request(RUN_PATH, { body: JSON.stringify({ name: "clear presence" }), method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("dispatches a function job to its shard and reports it ran", async () => {
        expect.assertions(4);

        const shard = createShardSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: shard.namespace });

        const response = await worker.fetch(runRequest("clear presence"), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ name: "clear presence", ran: true });
        expect(shard.calls).toHaveLength(1);
        expect(shard.calls[0]).toStrictEqual({ body: { args: { tenant: "acme" }, functionPath: "presence:clear" }, shardKey: "acme" });
    });

    it("starts a workflow instance for a workflow-targeting job", async () => {
        expect.assertions(2);

        const created: { params?: unknown }[] = [];
        const env = {
            WORKFLOW_DIGEST: {
                create: async (options?: { params?: unknown }) => {
                    created.push(options ?? {});

                    return { id: "wf-1" };
                },
            },
        };
        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: createShardSpy().namespace });

        const response = await worker.fetch(runRequest("nightly digest"), env, fakeContext);

        expect(response.status).toBe(200);
        expect(created).toStrictEqual([{ params: { region: "eu" } }]);
    });

    it("starts a fresh instance on every cron run — the cron path deliberately passes no instance id", async () => {
        expect.assertions(2);

        // The scheduler path forwards its record id as the workflow instance id
        // so an at-least-once re-fire is deduped. The cron path must NOT: there
        // is no record id, every scheduled fire of the same expression is a
        // distinct run, and this "Run now" trigger has to be repeatable on
        // demand. A stable per-job key here would make the second fire a
        // duplicate and silently never run again.
        const created: { id?: string; params?: unknown }[] = [];
        const env = {
            WORKFLOW_DIGEST: {
                create: async (options?: { id?: string; params?: unknown }) => {
                    created.push(options ?? {});

                    return { id: "wf-1" };
                },
            },
        };
        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: createShardSpy().namespace });

        await worker.fetch(runRequest("nightly digest"), env, fakeContext);
        await worker.fetch(runRequest("nightly digest"), env, fakeContext);

        expect(created).toHaveLength(2);
        expect(created.every((options) => options.id === undefined)).toBe(true);
    });

    it("returns 404 for an unknown job name", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: createShardSpy().namespace });

        const response = await worker.fetch(runRequest("does not exist"), {}, fakeContext);

        expect(response.status).toBe(404);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("CRON_JOB_NOT_FOUND");
    });

    it("reports CRON_JOBS_NOT_CONFIGURED when no map is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: createShardSpy().namespace });

        const response = await worker.fetch(runRequest("clear presence"), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("CRON_JOBS_NOT_CONFIGURED");
    });

    it("propagates a failing function dispatch as an error", async () => {
        expect.assertions(1);

        const shard = createShardSpy(new Response("boom", { status: 500 }));
        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: shard.namespace });

        const response = await worker.fetch(runRequest("clear presence"), {}, fakeContext);

        expect(response.status).toBe(500);
    });
});
