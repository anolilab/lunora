import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, KvIntrospector } from "../src/create-worker";
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
const VALUE_URL = "https://app.example/_lunora/admin/kv/value";

const introspector = (overrides: Partial<KvIntrospector> = {}): KvIntrospector => {
    return {
        deleteKey: async () => undefined,
        getValue: async () => {
            return { metadata: null, value: "v" };
        },
        listKeys: async () => {
            return { keys: [], listComplete: true };
        },
        listNamespaces: async () => [{ binding: "CACHE" }],
        putValue: async () => undefined,
        ...overrides,
    };
};

const putRequest = (body: Record<string, unknown>): Request =>
    new Request(VALUE_URL, { body: JSON.stringify(body), headers: { ...AUTH, "content-type": "application/json" }, method: "PUT" });

describe("createWorker — kv admin endpoints", () => {
    it("returns 404 for an unknown namespace binding", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(putRequest({ key: "k", namespace: "MISSING", value: "v" }), {}, fakeContext);

        expect(response.status).toBe(404);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("NOT_FOUND");
    });

    it("rejects a literal `null` PUT body with 400, not a 500 from dereferencing it (RUNTIME-04)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request(VALUE_URL, { body: "null", headers: { ...AUTH, "content-type": "application/json" }, method: "PUT" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("BAD_REQUEST");
    });

    it("rejects an absolute expiration that is not >= 60s in the future (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector(), shardDO: noopNamespace });
        const soon = Math.floor(Date.now() / 1000) + 10; // <60s away — invalid

        const response = await worker.fetch(putRequest({ expiration: soon, key: "k", namespace: "CACHE", value: "v" }), {}, fakeContext);

        expect(response.status).toBe(400);
    });

    it("accepts an absolute expiration >= 60s in the future", async () => {
        expect.assertions(2);

        const putValue = vi.fn<KvIntrospector["putValue"]>(async () => undefined);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector({ putValue }), shardDO: noopNamespace });
        const future = Math.floor(Date.now() / 1000) + 3600;

        const response = await worker.fetch(putRequest({ expiration: future, key: "k", namespace: "CACHE", value: "v" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(putValue).toHaveBeenCalledWith(expect.objectContaining({ expiration: future, key: "k", namespace: "CACHE", value: "v" }));
    });

    it("rejects an expirationTtl below 60 (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(putRequest({ expirationTtl: 30, key: "k", namespace: "CACHE", value: "v" }), {}, fakeContext);

        expect(response.status).toBe(400);
    });

    it("accepts a KV value PUT above the shared 1 MiB body cap (KV path is exempt from the global Content-Length fast-path)", async () => {
        expect.assertions(2);

        // A ~2 MiB value — over the shared 1 MiB `MAX_BODY_BYTES`. The global
        // Content-Length fast-path would 413 it before routing unless the KV value
        // path uses its own 32 MiB budget (Cloudflare KV allows up to 25 MiB).
        const putValue = vi.fn<KvIntrospector["putValue"]>(async () => undefined);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, kvIntrospector: introspector({ putValue }), shardDO: noopNamespace });
        const bigValue = "x".repeat(2 * 1_048_576);

        const response = await worker.fetch(putRequest({ key: "k", namespace: "CACHE", value: bigValue }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(putValue).toHaveBeenCalledWith(expect.objectContaining({ key: "k", namespace: "CACHE", value: bigValue }));
    });

    it("still rejects a >1 MiB body on a non-KV path with 413 (the exemption is scoped to the KV value path)", async () => {
        expect.assertions(1);

        // The global cap must remain enforced everywhere else: an oversized body
        // on `/_lunora/rpc` still 413s (the KV exemption is path-scoped).
        const worker = createWorker({ shardDO: noopNamespace });
        const bigBody = JSON.stringify({ args: { blob: "x".repeat(2 * 1_048_576) }, functionPath: "messages:list" });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/rpc", { body: bigBody, headers: { "content-type": "application/json" }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
    });
});
