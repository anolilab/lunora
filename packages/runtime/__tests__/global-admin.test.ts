import { describe, expect, test, vi } from "vitest";

import type { ExecutionContextLike, GlobalIntrospector } from "../src/create-worker.js";
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

const TABLES = [{ name: "organizations", rowCount: 2 }];
const PAGE = { columns: ["_id", "name"], rows: [{ _id: "o1", name: "Acme" }], total: 2 };

const introspector = (): GlobalIntrospector => ({
    listTables: vi.fn(async () => TABLES),
    readTablePage: vi.fn(async () => PAGE),
});

describe("createWorker — global introspection endpoints", () => {
    test("tables rejects without a valid admin bearer (403)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/global/tables", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("tables reports GLOBALS_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("GLOBALS_NOT_CONFIGURED");
    });

    test("tables returns the introspector's table list", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(TABLES);
    });

    test("table forwards table / limit / offset and returns the page", async () => {
        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/table?table=organizations&limit=10&offset=5", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        expect(intro.readTablePage).toHaveBeenCalledWith({ limit: 10, offset: 5, table: "organizations" });
    });

    test("table rejects a missing `table` param (400)", async () => {
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/table", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
    });
});
