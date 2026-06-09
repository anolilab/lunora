import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, StorageListFn as StorageListFunction } from "../src/create-worker";
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

const PAGE = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };

describe("createWorker — storage admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/storage", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports STORAGE_NOT_CONFIGURED when no lister is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("STORAGE_NOT_CONFIGURED");
    });

    it("forwards prefix / cursor / limit to the lister and returns the page", async () => {
        expect.assertions(3);

        const storageList = vi.fn<StorageListFunction>(async () => PAGE);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage?prefix=avatars/&cursor=z&limit=25", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        expect(storageList).toHaveBeenCalledWith("avatars/", { cursor: "z", limit: 25 });
    });

    it("rejects non-GET (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace, storageList: async () => PAGE });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/storage", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(405);
    });
});
