import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

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

const REGISTRY: FunctionRegistryLike = {
    "billing:sync": { kind: "action", visibility: "public" },
    "internal:sweep": { kind: "mutation", visibility: "internal" },
    "messages:list": { kind: "query" },
    "messages:send": { kind: "mutation" },
};

describe("createWorker — functions admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/functions", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports FUNCTIONS_NOT_CONFIGURED when no registry is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("FUNCTIONS_NOT_CONFIGURED");
    });

    it("returns public functions sorted by path, omitting internal ones", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            functions: [
                { args: [], kind: "action", path: "billing:sync" },
                { args: [], kind: "query", path: "messages:list" },
                { args: [], kind: "mutation", path: "messages:send" },
            ],
        });
    });

    it("includes each function's argument signature derived from its validators", async () => {
        expect.assertions(1);

        // Structural validator stand-ins — the endpoint reads `kind` + `_meta`.
        const registry: FunctionRegistryLike = {
            "messages:send": {
                args: {
                    channelId: { _meta: { tableName: "channels" }, kind: "id" },
                    replyTo: { _meta: { inner: { _meta: { tableName: "messages" }, kind: "id" } }, kind: "optional" },
                    text: { kind: "string" },
                },
                kind: "mutation",
            },
        };

        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: registry, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        const body: { functions: { args: unknown }[] } = await response.json();

        expect(body.functions[0]?.args).toEqual([
            { kind: "id", name: "channelId", optional: false, table: "channels" },
            { kind: "id", name: "replyTo", optional: true, table: "messages" },
            { kind: "string", name: "text", optional: false },
        ]);
    });

    it("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/functions", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
