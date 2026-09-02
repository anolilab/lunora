import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
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

const RECORDS = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2000 }];

const STATUS = { backlog: 5, inFlight: 2, pools: [{ inFlight: 2, maxConcurrency: 3, name: "mail", queued: 5 }] };

const DEAD_RECORDS = [{ args: {}, attempts: 6, enqueuedAt: 1, functionPath: "email:send", id: "j9", scheduledFor: 2000 }];

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

            if (url.pathname === "/status") {
                return Response.json(STATUS);
            }

            if (url.pathname === "/dead") {
                return Response.json({ records: DEAD_RECORDS });
            }

            if (url.pathname === "/dead/retry") {
                return Response.json({ id: "j9", retried: true, scheduledFor: 3000 });
            }

            if (url.pathname === "/dead/cancel") {
                return Response.json({ removed: true });
            }

            if (url.pathname === "/complete") {
                return Response.json({ inFlight: 0 });
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

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/scheduled", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("list reports SCHEDULER_NOT_CONFIGURED when no namespace is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
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
            new Request("https://app.example/_lunora/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
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
            new Request("https://app.example/_lunora/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(idArgs).toEqual(["tenant-a"]);
    });

    it("list rejects non-GET (405)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });

    it("status rejects without a valid admin bearer (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/scheduled/status", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
        // The admin gate rejects before the request ever reaches the DO stub.
        expect(calls).toEqual([]);
    });

    it("status reports SCHEDULER_NOT_CONFIGURED when no namespace is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/status", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("SCHEDULER_NOT_CONFIGURED");
    });

    it("status forwards GET /status to the default scheduler instance and returns the backlog", async () => {
        expect.assertions(4);

        const { calls, idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/status", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: unknown = await response.json();

        expect(body).toEqual(STATUS);
        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/status" }]);
        expect(idArgs).toEqual(["default"]);
    });

    it("status targets a named scheduler instance", async () => {
        expect.assertions(1);

        const { idArgs, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, schedulerInstanceName: "tenant-a", shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/status", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(idArgs).toEqual(["tenant-a"]);
    });

    it("status rejects non-GET (405)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/status", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });

    it("cancel forwards POST /cancel with the id", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/cancel", {
                body: JSON.stringify({ id: "j1" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
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
            new Request("https://app.example/_lunora/admin/scheduled/cancel", {
                body: JSON.stringify({}),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
        expect(calls).toEqual([]);
    });

    it("dead-letter list forwards GET /dead and returns the parked records", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { records: unknown[] } = await response.json();

        expect(body.records).toEqual(DEAD_RECORDS);
        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/dead" }]);
    });

    it("dead-letter list rejects non-GET (405)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });

    it("dead-letter retry forwards POST /dead/retry with the id", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead/retry", {
                body: JSON.stringify({ id: "j9" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { retried: boolean } = await response.json();

        expect(body.retried).toBe(true);
        expect(calls).toEqual([{ body: JSON.stringify({ id: "j9" }), method: "POST", pathname: "/dead/retry" }]);
    });

    it("dead-letter cancel forwards POST /dead/cancel with the id", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead/cancel", {
                body: JSON.stringify({ id: "j9" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { removed: boolean } = await response.json();

        expect(body.removed).toBe(true);
        expect(calls).toEqual([{ body: JSON.stringify({ id: "j9" }), method: "POST", pathname: "/dead/cancel" }]);
    });

    it("dead-letter actions reject a missing id (400) without reaching the DO", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const retry = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead/retry", {
                body: JSON.stringify({}),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );
        const cancel = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/dead/cancel", {
                body: JSON.stringify({}),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(retry.status).toBe(400);
        expect(cancel.status).toBe(400);
        expect(calls).toEqual([]);
    });

    it("ws proxies the upgrade to the scheduler's /ws with a valid bearer", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/ws", { headers: { authorization: `Bearer ${ADMIN_TOKEN}`, Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    it("ws accepts a ?token= upgrade only when master-token-in-URL is explicitly opted back in", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        // Enforcement is the default (browsers can't set headers, so the studio
        // sends a minted sub-token here); the raw master token in a URL is refused.
        const enforced = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });
        const refused = await enforced.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(refused.status).toBe(403);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: false, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(calls).toEqual([{ body: "", method: "GET", pathname: "/ws" }]);
    });

    it("ws rejects an upgrade with no admin credentials (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/ws", { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });

    it("ws rejects a non-upgrade request (426)", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(426);
    });

    it("pool release forwards POST /complete with the id and pool", async () => {
        expect.assertions(3);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/pool/release", {
                body: JSON.stringify({ id: "j1", pool: "mail" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { inFlight: number } = await response.json();

        expect(body.inFlight).toBe(0);
        expect(calls).toEqual([{ body: JSON.stringify({ id: "j1", pool: "mail" }), method: "POST", pathname: "/complete" }]);
    });

    it("pool release rejects a missing pool (400)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/pool/release", {
                body: JSON.stringify({ id: "j1" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
        expect(calls).toEqual([]);
    });

    it("pool release rejects without a valid admin bearer (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/scheduled/pool/release", {
                body: JSON.stringify({ id: "j1", pool: "mail" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });
});
