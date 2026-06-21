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
    info: { title: "Lunora RPC", version: "1.2.3" },
    methods: [{ name: "messages:list", params: [{ name: "args" }] }],
    openrpc: "1.3.2",
};

describe("createWorker — openrpc admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openRpcSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/openrpc", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("serves the injected spec verbatim (200)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openRpcSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/openrpc", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(SPEC);
    });

    it("returns an empty-but-valid OpenRPC document when no spec is configured (200)", async () => {
        expect.assertions(4);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/openrpc", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { methods?: unknown[]; openrpc?: string } = await response.json();

        expect(body.openrpc).toBe("1.3.2");
        expect(body.methods).toEqual([]);
        // The empty fallback is still well-formed (carries an `info` block).
        expect(body).toHaveProperty("info.title", "Lunora RPC");
    });

    it("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, openRpcSpec: SPEC, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/openrpc", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
