import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => { return { fetch: async () => new Response("not used", { status: 200 }) }; },
    idFromName: (name) => { return { __name: name }; },
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
    it("list rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/scheduled", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    it("list reports SCHEDULER_NOT_CONFIGURED when no namespace is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("SCHEDULER_NOT_CONFIGURED");
    });

    it("list forwards GET /list to the default scheduler instance", async () => {
        expect.assertions(4);

        const { calls, idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);

        const body: { records: unknown } = await response.json();

        expect(body.records).toEqual(RECORDS);
        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/list" }]);
        expect(idArgs).toEqual(["default"]);
    });

    it("list targets a named scheduler instance", async () => {
        expect.assertions(1);

        const { idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, schedulerInstanceName: "tenant-a", shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(idArgs).toEqual(["tenant-a"]);
    });

    it("list rejects non-GET (405)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(405);
    });

    it("cancel forwards POST /cancel with the id", async () => {
        expect.assertions(3);

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

        const body: { cancelled: boolean } = await response.json();

        expect(body.cancelled).toBe(true);
        expect(calls).toEqual([{ body: JSON.stringify({ id: "j1" }), method: "POST", pathname: "/cancel" }]);
    });

    it("cancel rejects a missing id (400)", async () => {
        expect.assertions(2);

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

    it("ws proxies the upgrade to the scheduler's /ws with a valid bearer", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_cirrus/admin/scheduled/ws", { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, Upgrade: "websocket" } }),
            {},
            fakeCtx,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    it("ws accepts the admin token via the ?token query parameter (browsers can't set headers)", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request(`https://app.example/_cirrus/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeCtx,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    it("ws rejects an upgrade with no admin credentials (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/scheduled/ws", { headers: { Upgrade: "websocket" } }), {}, fakeCtx);

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });

    it("ws rejects a non-upgrade request (426)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`https://app.example/_cirrus/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(426);
    });
});
