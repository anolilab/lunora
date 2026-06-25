import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, GlobalIntrospector } from "../src/create-worker";
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

const TABLES = [{ name: "organizations", rowCount: 2 }];
const PAGE = { columns: ["_id", "name"], rows: [{ _id: "o1", name: "Acme" }], total: 2 };
const FACET = { truncated: false, values: [{ count: 2, value: "Acme" }] };

const introspector = (): GlobalIntrospector => {
    return {
        facetColumn: vi.fn<GlobalIntrospector["facetColumn"]>(async () => FACET),
        listTables: vi.fn<GlobalIntrospector["listTables"]>(async () => TABLES),
        readTablePage: vi.fn<GlobalIntrospector["readTablePage"]>(async () => PAGE),
    };
};

describe("createWorker — global introspection endpoints", () => {
    it("tables rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/global/tables", { method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("authorizes via env.LUNORA_ADMIN_TOKEN when no options.adminToken is set (the composeWorker default)", async () => {
        expect.assertions(2);

        // composeWorker passes no `adminToken`; the admin gate must fall back to
        // `env.LUNORA_ADMIN_TOKEN` (the value the Studio + worker share via .dev.vars).
        const worker = createWorker({ globalIntrospector: introspector(), shardDO: noopNamespace });
        const url = "https://app.example/_lunora/admin/global/tables";

        const authorized = await worker.fetch(
            new Request(url, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            fakeContext,
        );

        expect(authorized.status).toBe(200);

        // No bearer → still 403 even though the env token is set.
        const rejected = await worker.fetch(new Request(url, { method: "GET" }), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN }, fakeContext);

        expect(rejected.status).toBe(403);
    });

    it("tables reports GLOBALS_NOT_CONFIGURED when no introspector is bound (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("GLOBALS_NOT_CONFIGURED");
    });

    it("tables returns the introspector's table list", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/global/tables", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(TABLES);
    });

    it("table forwards table / limit / offset and returns the page", async () => {
        expect.assertions(3);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: intro, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/global/table?table=organizations&limit=10&offset=5", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        expect(intro.readTablePage).toHaveBeenCalledWith({ limit: 10, offset: 5, table: "organizations" });
    });

    it("table rejects a missing `table` param (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/global/table", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
    });

    it("table parses the JSON `filters` param into eq clauses", async () => {
        expect.assertions(2);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: intro, shardDO: noopNamespace });
        const filters = encodeURIComponent(JSON.stringify([{ column: "name", value: "Acme" }]));

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/global/table?table=organizations&filters=${filters}`, {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(intro.readTablePage).toHaveBeenCalledWith({ filters: [{ column: "name", value: "Acme" }], table: "organizations" });
    });

    it("facet forwards table / column / filters and returns the summary", async () => {
        expect.assertions(3);

        const intro = introspector();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: intro, shardDO: noopNamespace });
        const filters = encodeURIComponent(JSON.stringify([{ column: "name", value: "Acme" }]));

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/global/facet?table=organizations&column=name&limit=5&filters=${filters}`, {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(FACET);
        expect(intro.facetColumn).toHaveBeenCalledWith({ column: "name", filters: [{ column: "name", value: "Acme" }], limit: 5, table: "organizations" });
    });

    it("facet rejects a missing `column` param (400)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, globalIntrospector: introspector(), shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/global/facet?table=organizations", {
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "GET",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(400);
    });
});
