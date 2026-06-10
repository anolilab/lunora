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

const SPEC = {
    info: { title: "Cirrus API", version: "1.2.3" },
    openapi: "3.1.0",
    paths: { "/_cirrus/rpc#messages:list": { post: { operationId: "messages:list" } } },
};

describe("createWorker — openapi admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openApiSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/openapi", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("serves the injected spec verbatim (200)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openApiSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/openapi", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(SPEC);
    });

    it("returns an empty-but-valid OpenAPI 3.1 document when no spec is configured (200)", async () => {
        expect.assertions(4);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/openapi", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { openapi?: string; paths?: Record<string, unknown> } = await response.json();

        expect(body.openapi).toBe("3.1.0");
        expect(body.paths).toEqual({});
        // The empty fallback is still well-formed (carries an `info` block).
        expect(body).toHaveProperty("info.title", "Cirrus API");
    });

    it("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openApiSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/openapi", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
