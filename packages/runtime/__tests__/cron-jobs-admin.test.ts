import { describe, expect, it } from "vitest";

import type { CronJobInfo, ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

const CRON_JOBS = {
    "*/5 * * * *": [{ args: { tenant: "acme" }, functionPath: "presence:clear", name: "clear presence", shardKey: "acme" }],
    "0 9 * * *": [{ args: {}, functionPath: "report:daily", name: "daily digest" }],
};

describe("createWorker — cron-jobs admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/cron-jobs", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports CRON_JOBS_NOT_CONFIGURED when no map is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/cron-jobs", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("CRON_JOBS_NOT_CONFIGURED");
    });

    it("flattens the cron map into a list sorted by name, each carrying its expression", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/cron-jobs", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { jobs: CronJobInfo[] } = await response.json();

        expect(body.jobs).toEqual([
            { args: { tenant: "acme" }, cron: "*/5 * * * *", functionPath: "presence:clear", name: "clear presence", shardKey: "acme" },
            { args: {}, cron: "0 9 * * *", functionPath: "report:daily", name: "daily digest" },
        ]);
    });

    it("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, cronJobs: CRON_JOBS, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/cron-jobs", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
