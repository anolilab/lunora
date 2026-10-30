import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { PAUSED_QUEUE_RETRY_SECONDS } from "../src/deployment-pause";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const admin = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

/** A shard that counts the function calls that reach it. */
const countingShard = (): { calls: () => number; namespace: ShardNamespaceLike } => {
    let calls = 0;

    return {
        calls: () => calls,
        namespace: {
            get: () => {
                return {
                    fetch: async () => {
                        calls += 1;

                        return Response.json({ result: null });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        },
    };
};

/** The SchedulerDO's `/pause` contract, in memory, counting reads. */
const pausableScheduler = (): { namespace: ShardNamespaceLike; reads: () => number } => {
    let state: Record<string, unknown> = { paused: false };
    let reads = 0;

    return {
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        if (request.method === "GET") {
                            reads += 1;

                            return Response.json(state);
                        }

                        const body: { paused: boolean; reason?: string } = await request.json();

                        state = body.paused ? { paused: true, pausedAt: 1, ...(body.reason === undefined ? {} : { reason: body.reason }) } : { paused: false };

                        return Response.json(state);
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        },
        reads: () => reads,
    };
};

const rpc = (headers?: Record<string, string>): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args: {}, functionPath: "todos:list" }),
        headers: headers ?? { "content-type": "application/json" },
        method: "POST",
    });

const setPaused = (paused: boolean, reason?: string): Request =>
    new Request("https://app.example/_lunora/admin/pause", { body: JSON.stringify({ paused, reason }), headers: admin, method: "POST" });

describe("createWorker — deployment pause", () => {
    it("refuses function calls with 503 DEPLOYMENT_PAUSED while paused, keeps the admin plane open, and serves again on resume", async () => {
        expect.hasAssertions();

        const shard = countingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: pausableScheduler().namespace, shardDO: shard.namespace });

        const paused = await worker.fetch(setPaused(true, "incident 42"), {}, fakeContext);

        await expect(paused.json()).resolves.toMatchObject({
            paused: true,
            reason: "incident 42",
            supported: true,
        });

        const refused = await worker.fetch(rpc(), {}, fakeContext);

        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe("30");
        // The operator's note stays on the admin route; callers get a fixed message.
        await expect(refused.json()).resolves.toStrictEqual({ error: { code: "DEPLOYMENT_PAUSED", message: "the deployment is paused" } });
        expect(shard.calls()).toBe(0);

        // The operator's own calls still run, and the status read stays reachable.
        await worker.fetch(rpc(admin), {}, fakeContext);

        expect(shard.calls()).toBe(1);

        const status = await worker.fetch(new Request("https://app.example/_lunora/admin/pause", { headers: admin }), {}, fakeContext);

        await expect(status.json()).resolves.toMatchObject({ paused: true });

        await worker.fetch(setPaused(false), {}, fakeContext);

        const served = await worker.fetch(rpc(), {}, fakeContext);

        expect(served.status).toBe(200);
        expect(shard.calls()).toBe(2);
    });

    it("lets an adminGate-only operator's function calls through while paused", async () => {
        expect.hasAssertions();

        const shard = countingShard();
        const access = { "cf-access-jwt-assertion": "operator", "content-type": "application/json" };
        const worker = createWorker({
            adminGate: (request) => request.headers.get("cf-access-jwt-assertion") === "operator",
            schedulerDO: pausableScheduler().namespace,
            shardDO: shard.namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/pause", { body: JSON.stringify({ paused: true }), headers: access, method: "POST" }),
            {},
            fakeContext,
        );

        const refused = await worker.fetch(rpc(), {}, fakeContext);

        expect(refused.status).toBe(503);

        await worker.fetch(rpc(access), {}, fakeContext);

        expect(shard.calls()).toBe(1);
    });

    it("lets Studio's ticketed WebSocket upgrade through while refusing an anonymous one", async () => {
        expect.hasAssertions();

        const shard = countingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: pausableScheduler().namespace, shardDO: shard.namespace });

        await worker.fetch(setPaused(true), {}, fakeContext);

        const minted = await worker.fetch(new Request("https://app.example/_lunora/admin/ws-token", { headers: admin, method: "POST" }), {}, fakeContext);
        const { token } = await minted.json<{ token: string }>();
        const upgrade = (query: string): Request => new Request(`https://app.example/_lunora/ws${query}`, { headers: { Upgrade: "websocket" } });

        const anonymous = await worker.fetch(upgrade(""), {}, fakeContext);

        expect(anonymous.status).toBe(503);
        expect(shard.calls()).toBe(0);

        await worker.fetch(upgrade(`?token=${encodeURIComponent(token)}`), {}, fakeContext);

        expect(shard.calls()).toBe(1);
    });

    it("reads the flag at most once per cache window", async () => {
        expect.hasAssertions();

        const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
        const scheduler = pausableScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: scheduler.namespace, shardDO: countingShard().namespace });

        await worker.fetch(rpc(), {}, fakeContext);
        await worker.fetch(rpc(), {}, fakeContext);

        expect(scheduler.reads()).toBe(1);

        now.mockReturnValue(1_005_000);
        await worker.fetch(rpc(), {}, fakeContext);

        expect(scheduler.reads()).toBe(2);

        now.mockRestore();
    });

    it("shares one flag read between concurrent calls", async () => {
        expect.hasAssertions();

        const scheduler = pausableScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: scheduler.namespace, shardDO: countingShard().namespace });

        await Promise.all([worker.fetch(rpc(), {}, fakeContext), worker.fetch(rpc(), {}, fakeContext), worker.fetch(rpc(), {}, fakeContext)]);

        expect(scheduler.reads()).toBe(1);
    });

    it("keeps a fresh toggle when an older read resolves after it", async () => {
        expect.hasAssertions();

        let state: Record<string, unknown> = { paused: false };
        let releaseRead: (() => void) | undefined;
        let gateFirstRead = true;
        const namespace: ShardNamespaceLike = {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        if (request.method === "GET") {
                            const snapshot = state;

                            if (gateFirstRead) {
                                gateFirstRead = false;
                                await new Promise<void>((resolve) => {
                                    releaseRead = resolve;
                                });
                            }

                            return Response.json(snapshot);
                        }

                        const body: { paused: boolean } = await request.json();

                        state = { paused: body.paused };

                        return Response.json(state);
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const shard = countingShard();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: shard.namespace });

        // A call's background read starts while the flag is still clear and stalls.
        const inFlight = worker.fetch(rpc(), {}, fakeContext);

        await worker.fetch(setPaused(true), {}, fakeContext);
        releaseRead?.();
        await inFlight;

        // The isolate that set the flag must see it at once, not the stale read.
        const refused = await worker.fetch(rpc(), {}, fakeContext);

        expect(refused.status).toBe(503);
    });

    it("tells the queue consumer to hold its batch while paused, and to run it once resumed", async () => {
        expect.hasAssertions();

        const queue = vi.fn<(batch: unknown, env: unknown, context: unknown, trigger: { holdSeconds?: number }) => Promise<void>>(async () => undefined);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queue, schedulerDO: pausableScheduler().namespace, shardDO: countingShard().namespace });

        await worker.fetch(setPaused(true), {}, fakeContext);
        await worker.queue?.({ messages: [], queue: "jobs" }, {}, fakeContext);

        expect(queue).toHaveBeenCalledTimes(1);
        expect(queue.mock.calls[0]?.[3].holdSeconds).toBe(PAUSED_QUEUE_RETRY_SECONDS);

        await worker.fetch(setPaused(false), {}, fakeContext);
        await worker.queue?.({ messages: [], queue: "jobs" }, {}, fakeContext);

        expect(queue).toHaveBeenCalledTimes(2);
        expect(queue.mock.calls[1]?.[3].holdSeconds).toBeUndefined();
    });

    it("hands a forwarded tenant queue batch back for retry while paused", async () => {
        expect.hasAssertions();

        const queueHandler = vi.fn<() => Promise<{ retry: string[] }>>(async () => {
            return { retry: [] };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queueHandler, schedulerDO: pausableScheduler().namespace, shardDO: countingShard().namespace });
        const forward = (): Request =>
            new Request("https://app.example/_lunora/queue", {
                body: JSON.stringify({
                    messages: [
                        { body: 1, id: "m1" },
                        { body: 2, id: "m2" },
                    ],
                    queue: "jobs",
                }),
                headers: admin,
                method: "POST",
            });

        await worker.fetch(setPaused(true), {}, fakeContext);

        const held = await worker.fetch(forward(), {}, fakeContext);

        await expect(held.json()).resolves.toStrictEqual({ retry: ["m1", "m2"] });
        expect(queueHandler).not.toHaveBeenCalled();

        await worker.fetch(setPaused(false), {}, fakeContext);
        await worker.fetch(forward(), {}, fakeContext);

        expect(queueHandler).toHaveBeenCalledTimes(1);
    });

    it("skips a raw crons handler while paused", async () => {
        expect.hasAssertions();

        const handler = vi.fn<() => Promise<void>>(async () => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            crons: { "* * * * *": handler },
            schedulerDO: pausableScheduler().namespace,
            shardDO: countingShard().namespace,
        });

        await worker.fetch(setPaused(true), {}, fakeContext);
        await worker.scheduled?.({ cron: "* * * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(handler).not.toHaveBeenCalled();

        await worker.fetch(setPaused(false), {}, fakeContext);
        await worker.scheduled?.({ cron: "* * * * *", scheduledTime: 0 }, {}, fakeContext);

        expect(handler).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("reports pausing as unsupported on a worker without a scheduler", async () => {
        expect.hasAssertions();

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: countingShard().namespace });
        const status = await worker.fetch(new Request("https://app.example/_lunora/admin/pause", { headers: admin }), {}, fakeContext);
        const refused = await worker.fetch(setPaused(true), {}, fakeContext);

        await expect(status.json()).resolves.toStrictEqual({ paused: false, supported: false });
        expect(refused.status).toBe(400);
        await expect(refused.json()).resolves.toMatchObject({ error: { code: "PAUSE_NOT_CONFIGURED" } });
    });

    it("refuses to change the flag without the admin bearer", async () => {
        expect.hasAssertions();

        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: pausableScheduler().namespace, shardDO: countingShard().namespace });
        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/pause", {
                body: JSON.stringify({ paused: true }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
    });
});
