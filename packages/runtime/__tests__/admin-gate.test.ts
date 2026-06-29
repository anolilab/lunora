import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker";
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

const REGISTRY: FunctionRegistryLike = { "messages:list": { kind: "query" } };
const ADMIN_TOKEN = "static-bearer";
const ADMIN_PATH = "https://app.example/_lunora/admin/functions";

describe("createWorker — adminGate (async Access-style admin authorization)", () => {
    it("authorizes an admin route when adminGate resolves true, with no bearer", async () => {
        expect.assertions(2);

        const adminGate = vi.fn(async () => true);
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(adminGate).toHaveBeenCalledTimes(1);
    });

    it("denies (403) when adminGate resolves false and no bearer is supplied", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminGate: async () => false, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("still accepts the static admin bearer when adminGate resolves false", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminGate: async () => false, adminToken: ADMIN_TOKEN, functions: REGISTRY, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(ADMIN_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
    });

    it("denies (403) when adminGate throws and no bearer is supplied", async () => {
        expect.assertions(1);

        // A throwing gate must degrade to "no grant" (fail closed for the gate),
        // not propagate out and 500 the whole admin request.
        const worker = createWorker({
            adminGate: async () => {
                throw new Error("verification blew up");
            },
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request(ADMIN_PATH, { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("still accepts the static admin bearer when adminGate throws", async () => {
        expect.assertions(1);

        // The bearer path must survive a throwing gate — a failing Access check
        // cannot lock out a request carrying a valid static token.
        const worker = createWorker({
            adminGate: async () => {
                throw new Error("verification blew up");
            },
            adminToken: ADMIN_TOKEN,
            functions: REGISTRY,
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request(ADMIN_PATH, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(200);
    });

    it("never evaluates adminGate on the non-admin RPC hot path", async () => {
        expect.assertions(1);

        const adminGate = vi.fn(async () => true);
        const worker = createWorker({ adminGate, functions: REGISTRY, shardDO: noopNamespace });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(adminGate).not.toHaveBeenCalled();
    });
});
