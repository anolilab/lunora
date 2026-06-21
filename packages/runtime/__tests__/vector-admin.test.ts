import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, VectorIntrospector } from "../src/create-worker";
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
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

const introspector = (overrides: Partial<VectorIntrospector> = {}): VectorIntrospector => {
    return {
        listIndexes: async () => [{ dimensions: 1024, field: "body", metric: "cosine", name: "by_body", table: "docs", vectorsCount: 42 }],
        queryIndex: async ({ name, text, topK }) => {
            return {
                matches: [{ id: `${name}:${text}`, metadata: { topK }, score: 0.9 }],
            };
        },
        ...overrides,
    };
};

describe("createWorker — vector admin endpoints", () => {
    it("rejects listing without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, vectorIntrospector: introspector() });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/vector/indexes", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports VECTORS_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/vector/indexes", { headers: AUTH, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("VECTORS_NOT_CONFIGURED");
    });

    it("lists indexes from the introspector", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, vectorIntrospector: introspector() });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/vector/indexes", { headers: AUTH, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);

        const body: { indexes: { name: string; vectorsCount?: number }[] } = await response.json();

        expect(body.indexes).toEqual([{ dimensions: 1024, field: "body", metric: "cosine", name: "by_body", table: "docs", vectorsCount: 42 }]);
    });

    it("queries an index, forwarding name/text/topK to the introspector", async () => {
        expect.assertions(2);

        const queryIndex = vi.fn<NonNullable<VectorIntrospector["queryIndex"]>>(async () => {
            return { matches: [{ id: "m1", score: 0.5 }] };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, vectorIntrospector: introspector({ queryIndex }) });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/vector/query", {
                body: JSON.stringify({ name: "by_body", text: "hello", topK: 5 }),
                headers: { ...AUTH, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(queryIndex).toHaveBeenCalledWith({ name: "by_body", text: "hello", topK: 5 });
    });

    it("rejects a query with a missing text (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, vectorIntrospector: introspector() });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/vector/query", {
                body: JSON.stringify({ name: "by_body" }),
                headers: { ...AUTH, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
    });

    it("reports VECTOR_QUERY_UNSUPPORTED when the introspector has no queryIndex (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            shardDO: noopNamespace,
            vectorIntrospector: { listIndexes: async () => [] },
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/vector/query", {
                body: JSON.stringify({ name: "by_body", text: "hello" }),
                headers: { ...AUTH, "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("VECTOR_QUERY_UNSUPPORTED");
    });

    it("rejects non-GET on the list endpoint (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, vectorIntrospector: introspector() });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/vector/indexes", { headers: AUTH, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
