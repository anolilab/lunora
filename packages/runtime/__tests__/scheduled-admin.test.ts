import { describe, expect, test } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => ({ fetch: async () => new Response("not used", { status: 200 }) }),
    idFromName: (name) => ({ __name: name }),
};

const ADMIN_TOKEN = "admin-bear";

const RECORDS = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2000 }];

/** A scheduler namespace whose stub records the requests it receives. */
const recordingScheduler = (): { calls: { body: string; method: string; pathname: string }[]; idArgs: string[]; namespace: ShardNamespaceLike } => {
    const calls: { body: string; method: string; pathname: string }[] = [];
    const idArgs: string[] = [];

    const stub = {
        fetch: async (request: Request): Promise<Response> => {
            const url = new URL(request.url);
            const body = request.method === "POST" ? await request.text() : "";

            calls.push({ body, method: request.method, pathname: url.pathname });

            if (url.pathname === "/list") {
                return Response.json({ records: RECORDS });
            }

            return Response.json({ cancelled: true });
        },
    };

    const namespace: ShardNamespaceLike = {
        get: () => stub,
        idFromName: (name) => {
            idArgs.push(name);

            return { __name: name };
        },
    };

    return { calls, idArgs, namespace };
};

describe("createWorker — scheduled admin endpoints", () => {
    test("list rejects without a valid admin bearer (403)", async () => {
        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/scheduled", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("list reports SCHEDULER_NOT_CONFIGURED when no namespace is bound (400)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SCHEDULER_NOT_CONFIGURED");
    });

    test("list forwards GET /list to the default scheduler instance", async () => {
        const { calls, idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { records: unknown }).records).toEqual(RECORDS);
        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/list" }]);
        expect(idArgs).toEqual(["default"]);
    });

    test("list targets a named scheduler instance", async () => {
        const { idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, schedulerInstanceName: "tenant-a", shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(idArgs).toEqual(["tenant-a"]);
    });

    test("list rejects non-GET (405)", async () => {
        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(405);
    });

    test("cancel forwards POST /cancel with the id", async () => {
        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled/cancel", {
                body: JSON.stringify({ id: "j1" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { cancelled: boolean }).cancelled).toBe(true);
        expect(calls).toEqual([{ body: JSON.stringify({ id: "j1" }), method: "POST", pathname: "/cancel" }]);
    });

    test("cancel rejects a missing id (400)", async () => {
        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled/cancel", {
                body: JSON.stringify({}),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
        expect(calls).toEqual([]);
    });

    test("ws proxies the upgrade to the scheduler's /ws with a valid bearer", async () => {
        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled/ws", { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, Upgrade: "websocket" } }),
            {},
            fakeCtx,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    test("ws accepts the admin token via the ?token query parameter (browsers can't set headers)", async () => {
        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request(`https://app.example/_cirrus/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeCtx,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    test("ws rejects an upgrade with no admin credentials (403)", async () => {
        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/scheduled/ws", { headers: { Upgrade: "websocket" } }), {}, fakeCtx);

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });

    test("ws rejects a non-upgrade request (426)", async () => {
        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`https://app.example/_cirrus/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(426);
    });
});
