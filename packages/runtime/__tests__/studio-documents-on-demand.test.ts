import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * Studio's generated documents (architecture manifest, OpenAPI and OpenRPC specs) grow with the app,
 * and only their admin routes read them. The worker gets a loader for each and must call it on the
 * route's first authorized request, once, and never for an ordinary request (anolilab/neore#494).
 */

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const REGISTRY: FunctionRegistryLike = { "messages:list": { kind: "query" } };

const routes = [
    { document: { modules: [], version: 1 }, option: "architecture", path: "/_lunora/admin/architecture" },
    { document: { openapi: "3.1.0", paths: { "/x": {} } }, option: "openApiSpec", path: "/_lunora/admin/openapi" },
    { document: { methods: [{ name: "messages:list" }], openrpc: "1.3.2" }, option: "openRpcSpec", path: "/_lunora/admin/openrpc" },
] as const;

const adminGet = (path: string, authorized = true): Request =>
    new Request(`https://app.example${path}`, { headers: authorized ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}, method: "GET" });

describe("createWorker — Studio documents load on their route only", () => {
    it.each(routes)("never calls the $option loader for a function call, another admin route, a 403 or a 405", async ({ document, option, path }) => {
        expect.assertions(3);

        const shardFetch = vi.fn<() => Promise<Response>>(async () => Response.json({ value: [] }, { status: 200 }));
        const shardDO: ShardNamespaceLike = {
            get: () => {
                return { fetch: shardFetch };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const load = vi.fn<() => Promise<unknown>>(async () => document);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, allowUnauthenticatedShardAccess: true, functions: REGISTRY, [option]: load, shardDO });

        await worker.fetch(
            new Request("https://app.example/_lunora/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(shardFetch).toHaveBeenCalledTimes(1);

        await worker.fetch(adminGet("/_lunora/admin/functions"), {}, fakeContext);

        await expect(worker.fetch(adminGet(path, false), {}, fakeContext)).resolves.toHaveProperty("status", 403);

        await worker.fetch(new Request(`https://app.example${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }), {}, fakeContext);

        expect(load).not.toHaveBeenCalled();
    });

    it.each(routes)("loads the $option document on the first request to $path and keeps it", async ({ document, option, path }) => {
        expect.assertions(4);

        const load = vi.fn<() => Promise<unknown>>(async () => document);
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            [option]: load,
            shardDO: {
                get: () => {
                    return { fetch: async () => new Response("not used") };
                },
                idFromName: (name) => {
                    return { __name: name };
                },
            },
        });

        const [first, second] = await Promise.all([worker.fetch(adminGet(path), {}, fakeContext), worker.fetch(adminGet(path), {}, fakeContext)]);
        const third = await worker.fetch(adminGet(path), {}, fakeContext);

        expect(load).toHaveBeenCalledTimes(1);
        await expect(first.json()).resolves.toStrictEqual(document);
        await expect(second.json()).resolves.toStrictEqual(document);
        await expect(third.json()).resolves.toStrictEqual(document);
    });
});
