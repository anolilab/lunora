import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, GlobalIntrospector } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => { return { fetch: async () => new Response("not used", { status: 200 }) }; },
    idFromName: (name) => { return { __name: name }; },
};

const ADMIN_TOKEN = "admin-bear";

const TABLES = [{ name: "organizations", rowCount: 2 }];
const PAGE = { columns: ["_id", "name"], rows: [{ _id: "o1", name: "Acme" }], total: 2 };

const introspector = (): GlobalIntrospector => {
 return {
    listTables: vi.fn<GlobalIntrospector["listTables"]>(async () => TABLES),
    readTablePage: vi.fn<GlobalIntrospector["readTablePage"]>(async () => PAGE),
};
};

describe("createWorker — global introspection endpoints", () => {
    it("tables rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/global/tables", { method: "GET" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    it("tables reports GLOBALS_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("GLOBALS_NOT_CONFIGURED");
    });

    it("tables returns the introspector's table list", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(TABLES);
    });

    it("table forwards table / limit / offset and returns the page", async () => {
        expect.assertions(3);

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

    it("table rejects a missing `table` param (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/global/table", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(400);
    });
});
