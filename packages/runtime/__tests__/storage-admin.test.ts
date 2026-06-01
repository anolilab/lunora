import { describe, expect, test, vi } from "vitest";

import type { ExecutionContextLike, StorageListFn } from "../src/create-worker.js";
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

const PAGE = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };

describe("createWorker — storage admin endpoint", () => {
    test("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/storage", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("reports STORAGE_NOT_CONFIGURED when no lister is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_NOT_CONFIGURED");
    });

    test("forwards prefix / cursor / limit to the lister and returns the page", async () => {
        expect.assertions(3);

        const storageList = vi.fn<StorageListFn>(async () => PAGE);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage?prefix=avatars/&cursor=z&limit=25", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        expect(storageList).toHaveBeenCalledWith("avatars/", { cursor: "z", limit: 25 });
    });

    test("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(405);
    });
});
