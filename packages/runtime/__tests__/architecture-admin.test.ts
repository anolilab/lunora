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

const MANIFEST = {
    edges: [{ from: "function:billing_invoices:create", kind: "write", to: "table:invoices" }],
    nodes: [{ id: "table:invoices", kind: "table", name: "invoices", module: "billing" }],
    modules: [{ name: "billing", tables: ["invoices"] }],
    unresolved: [],
    version: 1,
};

const get = (authorized: boolean): Request =>
    new Request("https://app.example/_lunora/admin/architecture", { headers: authorized ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}, method: "GET" });

describe("createWorker — architecture admin endpoint", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, architecture: MANIFEST, shardDO: noopNamespace });

        await expect(worker.fetch(get(false), {}, fakeContext)).resolves.toHaveProperty("status", 403);
    });

    it("serves the injected manifest verbatim (200)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, architecture: MANIFEST, shardDO: noopNamespace });
        const response = await worker.fetch(get(true), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual(MANIFEST);
    });

    it("answers an empty manifest when the app declares no module (200)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const response = await worker.fetch(get(true), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ edges: [], nodes: [], modules: [], unresolved: [], version: 1 });
    });
});
