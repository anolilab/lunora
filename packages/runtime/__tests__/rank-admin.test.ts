import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const RANK_URL = "https://app.example/_cirrus/admin/rank";

interface ShardCall {
    authorization: null | string;
    body: { args: Record<string, unknown>; functionPath: string };
    shardKey: string;
}

/** Capturing shard namespace returning a canned `rankBefore` envelope per shard. */
const capturingNamespace = (calls: ShardCall[], counts: Record<string, [number, number]>): ShardNamespaceLike => {
    const stubFor = (shardKey: string) => {
        return {
            async fetch(request: Request): Promise<Response> {
                const body: { args: Record<string, unknown>; functionPath: string } = await request.json();

                calls.push({ authorization: request.headers.get("authorization"), body, shardKey });

                const [before, total] = counts[shardKey] ?? [0, 0];

                return Response.json({ result: { before, total } }, { status: 200 });
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

const rankBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return { index: "leaderboard", partitionKey: "", rowId: "u1", sortValues: [100], table: "scores", ...overrides };
};

const rankRequest = (body: Record<string, unknown>, token: string = ADMIN_TOKEN): Request =>
    new Request(RANK_URL, { body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` }, method: "POST" });

describe("createWorker — admin rank endpoint", () => {
    it("fans rankBefore out across every live shard and returns the merged global rank", async () => {
        expect.assertions(6);

        const calls: ShardCall[] = [];
        const namespace = capturingNamespace(calls, { a: [2, 5], b: [0, 3], c: [4, 6] });
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b", "c"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: namespace });

        const response = await worker.fetch(rankRequest(rankBody()), {}, fakeContext);

        expect(response.status).toBe(200);

        const result: { failed: number; ok: number; position: number; total: number } = await response.json();

        // Σbefore = 6 → position 7; Σtotal = 14.
        expect(result.position).toBe(7);
        expect(result.total).toBe(14);
        expect(result.ok).toBe(3);
        expect(calls).toHaveLength(3);
        // Each shard saw the rankBefore admin RPC carrying the forwarded admin bearer.
        expect(calls.every((c) => c.body.functionPath === "__cirrus_admin__:rankBefore" && c.authorization === `Bearer ${ADMIN_TOKEN}`)).toBe(true);
    });

    it("forwards the explicit key tuple verbatim to each shard", async () => {
        expect.assertions(3);

        const calls: ShardCall[] = [];
        const namespace = capturingNamespace(calls, { a: [0, 1] });
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: namespace });

        await worker.fetch(rankRequest(rankBody({ partitionKey: '{"region":"eu"}', rowId: "u9", sortValues: [42, "z"] })), {}, fakeContext);

        expect(calls[0]?.body.args.rowId).toBe("u9");
        expect(calls[0]?.body.args.partitionKey).toBe('{"region":"eu"}');
        expect(calls[0]?.body.args.sortValues).toEqual([42, "z"]);
    });

    it("rejects without the admin bearer", async () => {
        expect.assertions(2);

        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a"] }) });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: capturingNamespace([], {}) });

        const response = await worker.fetch(rankRequest(rankBody(), "wrong-token"), {}, fakeContext);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    });

    it("400s when no queryCoordinator is configured", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace([], {}) });

        const response = await worker.fetch(rankRequest(rankBody()), {}, fakeContext);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
    });

    it("400s on a malformed key tuple (missing rowId, non-array sortValues)", async () => {
        expect.assertions(2);

        const orchestrateRank = vi.fn<() => never>();
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a"] }) });
        // Spy through the real coordinator object so we can assert the guard fired before fan-out.
        coordinator.orchestrateRank = orchestrateRank;
        const worker = createWorker({ adminToken: ADMIN_TOKEN, queryCoordinator: coordinator, shardDO: capturingNamespace([], {}) });

        const missingRowId = await worker.fetch(rankRequest(rankBody({ rowId: "" })), {}, fakeContext);
        const badSortValues = await worker.fetch(rankRequest(rankBody({ sortValues: "nope" })), {}, fakeContext);

        expect([missingRowId.status, badSortValues.status]).toEqual([400, 400]);
        expect(orchestrateRank).not.toHaveBeenCalled();
    });
});
