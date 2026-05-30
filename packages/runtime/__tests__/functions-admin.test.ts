import { describe, expect, test } from "vitest";

import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker.js";
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

const REGISTRY: FunctionRegistryLike = {
    "messages:list": { kind: "query" },
    "messages:send": { kind: "mutation" },
    "internal:sweep": { kind: "mutation", visibility: "internal" },
    "billing:sync": { kind: "action", visibility: "public" },
};

describe("createWorker — functions admin endpoint", () => {
    test("rejects without a valid admin bearer (403)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/functions", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("reports FUNCTIONS_NOT_CONFIGURED when no registry is bound (400)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FUNCTIONS_NOT_CONFIGURED");
    });

    test("returns public functions sorted by path, omitting internal ones", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        expect((await response.json()) as { functions: unknown }).toEqual({
            functions: [
                { kind: "action", path: "billing:sync" },
                { kind: "query", path: "messages:list" },
                { kind: "mutation", path: "messages:send" },
            ],
        });
    });

    test("rejects non-GET (405)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(405);
    });
});
