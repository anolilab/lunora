import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const ADMIN_TOKEN = "admin-bear";
const PITR_URL = "https://app.example/_cirrus/admin/pitr";

interface Captured {
    authorization: null | string;
    body: string;
    shardName: unknown;
}

/** A shard namespace that records the forwarded request and returns a canned JSON response. */
const capturingNamespace = (captured: Captured[]): ShardNamespaceLike => {
    return {
        get: (id) => {
            return {
                fetch: async (request: Request) => {
                    captured.push({
                        authorization: request.headers.get("authorization"),
                        body: await request.text(),
                        shardName: (id as { __name?: unknown }).__name,
                    });

                    return Response.json({ result: { current: "bm-current" } }, { status: 200 });
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const pitrRequest = (body: unknown, token: string = ADMIN_TOKEN): Request =>
    new Request(PITR_URL, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}` },
        method: "POST",
    });

describe("createWorker — admin PITR endpoint", () => {
    it("forwards getPitrBookmark to the default shard with the admin bearer", async () => {
        expect.assertions(5);

        const captured: Captured[] = [];
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace(captured) });

        const response = await worker.fetch(pitrRequest({ args: {}, functionPath: "__cirrus_admin__:getPitrBookmark" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(captured).toHaveLength(1);

        const forwarded = JSON.parse(captured[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string };

        expect(forwarded.functionPath).toBe("__cirrus_admin__:getPitrBookmark");
        // The inbound admin bearer is forwarded so the shard's own admin gate accepts the op.
        expect(captured[0]?.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
        expect(forwarded.args).toStrictEqual({});
    });

    it("forwards pitrRestore to the named shard", async () => {
        expect.assertions(3);

        const captured: Captured[] = [];
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace(captured) });

        await worker.fetch(
            pitrRequest({ args: { restart: true, time: "2026-06-01T00:00:00.000Z" }, functionPath: "__cirrus_admin__:pitrRestore", shardKey: "tenant-7" }),
            {},
            fakeContext,
        );

        const forwarded = JSON.parse(captured[0]?.body ?? "{}") as { args: Record<string, unknown>; functionPath: string };

        expect(captured[0]?.shardName).toBe("tenant-7");
        expect(forwarded.functionPath).toBe("__cirrus_admin__:pitrRestore");
        expect(forwarded.args).toStrictEqual({ restart: true, time: "2026-06-01T00:00:00.000Z" });
    });

    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(2);

        const captured: Captured[] = [];
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace(captured) });

        const response = await worker.fetch(pitrRequest({ functionPath: "__cirrus_admin__:getPitrBookmark" }, "wrong-token"), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(captured).toHaveLength(0);
    });

    it("rejects a non-PITR functionPath (400)", async () => {
        expect.assertions(2);

        const captured: Captured[] = [];
        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace(captured) });

        const response = await worker.fetch(pitrRequest({ functionPath: "__cirrus_admin__:listTables" }), {}, fakeContext);

        expect(response.status).toBe(400);
        expect(captured).toHaveLength(0);
    });

    it("rejects non-POST (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: capturingNamespace([]) });

        const response = await worker.fetch(new Request(PITR_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), {}, fakeContext);

        expect(response.status).toBe(405);
    });
});
