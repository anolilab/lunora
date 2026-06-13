/**
 * Worker-route coverage for `POST /_cirrus/admin/shard-traffic` (`handleShardTraffic`).
 * The coordinator's `orchestrateShardTraffic` is unit-tested separately
 * (`query-coordinator.shard-traffic.test.ts`); this exercises the worker route
 * itself — the admin gate, the `queryCoordinator`-required guard, the method
 * guard, and that the inbound admin bearer is forwarded to each shard — so the
 * handler is protected before/through the admin-route extraction refactor.
 */
import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const TRAFFIC_URL = "https://app.example/_cirrus/admin/shard-traffic";

interface ShardCall {
    authorization: null | string;
    functionPath: string;
    shardKey: string;
}

/** Capturing shard namespace serving `__cirrus_admin__:getMetrics` per shard. */
const capturingNamespace = (calls: ShardCall[], requestsByShard: Record<string, number>): ShardNamespaceLike => {
    const stubFor = (shardKey: string) => {
        return {
            async fetch(request: Request): Promise<Response> {
                const body: { functionPath: string } = await request.json();

                calls.push({ authorization: request.headers.get("authorization"), functionPath: body.functionPath, shardKey });

                return Response.json({ result: { requests: requestsByShard[shardKey] ?? 0, shard: shardKey } }, { status: 200 });
            },
        };
    };

    return {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const trafficRequest = (token: string = ADMIN_TOKEN, method: string = "POST"): Request =>
    new Request(TRAFFIC_URL, { body: JSON.stringify({ table: "messages" }), headers: { authorization: `Bearer ${token}` }, method });

describe("createWorker — admin shard-traffic endpoint", () => {
    it("fans getMetrics across the live shards and returns per-shard request totals, forwarding the admin bearer", async () => {
        expect.assertions(4);

        const calls: ShardCall[] = [];
        const namespace = capturingNamespace(calls, { busy: 80, quiet: 20 });
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["busy", "quiet"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: namespace });

        const response = await worker.fetch(trafficRequest(), {}, fakeContext);

        expect(response.status).toBe(200);

        const result: { failed: number; ok: number; shards: { requests: number; shardKey: string }[] } = await response.json();

        expect(result.shards).toEqual([
            { requests: 80, shardKey: "busy" },
            { requests: 20, shardKey: "quiet" },
        ]);
        expect(result.ok).toBe(2);
        // Each shard saw the cheap getMetrics admin RPC carrying the forwarded bearer.
        expect(calls.every((call) => call.functionPath === "__cirrus_admin__:getMetrics" && call.authorization === `Bearer ${ADMIN_TOKEN}`)).toBe(true);
    });

    it("rejects without the admin bearer (403)", async () => {
        expect.assertions(2);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["busy"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: capturingNamespace([], {}) });

        const response = await worker.fetch(trafficRequest("wrong-token"), {}, fakeContext);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    });

    it("400s when no queryCoordinator is configured", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace([], {}) });

        const response = await worker.fetch(trafficRequest(), {}, fakeContext);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("rejects a non-POST method (405)", async () => {
        expect.assertions(1);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["busy"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: capturingNamespace([], {}) });

        // GET can't carry a body, so build it without one.
        const response = await worker.fetch(new Request(TRAFFIC_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(405);
    });
});
