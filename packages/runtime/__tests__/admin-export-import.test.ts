import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ExecutionContextLike, ShardingInfo } from "../src/create-worker.js";
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

describe("createWorker — admin export endpoint", () => {
    test("rejects without a configured admin token (403)", async () => {
        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/export", {
                body: JSON.stringify({ tables: ["users"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(403);
    });

    test("rejects without an authorization header (403)", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/export", { method: "POST" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("rejects non-POST (405)", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/export"), {}, fakeCtx);

        expect(response.status).toBe(405);
    });

    test("streams NDJSON from orchestrateExport", async () => {
        const orchestrateExport = vi.fn(async (_namespace: unknown, _request: { tables: ReadonlyArray<string> }) => ({
            failed: 0,
            ok: 1,
            shards: [
                {
                    rows: [
                        { doc: { _id: "u1", email: "a@b.com" }, table: "users" },
                        { doc: { _id: "u2", email: "c@d.com" }, table: "users" },
                    ],
                    shardKey: "__root__",
                },
            ],
        }));

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/export", {
                body: JSON.stringify({ tables: ["users"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/x-ndjson");

        const text = await response.text();
        const lines = text.trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });
    });

    test("streams D1 globals when exportGlobals is configured", async () => {
        const orchestrateExport = vi.fn(async (_namespace: unknown, _request: { tables: ReadonlyArray<string> }) => ({
            failed: 0,
            ok: 0,
            shards: [],
        }));

        const exportGlobals = vi.fn(async function* globalsIter() {
            yield { doc: { _id: "g1" }, table: "settings" };
            yield { doc: { _id: "g2" }, table: "settings" };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            exportGlobals: exportGlobals as never,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/export", {
                body: JSON.stringify({ tables: ["settings"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        const text = await response.text();
        const lines = text.trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toMatchObject({ table: "settings" });
    });
});

describe("createWorker — admin import endpoint", () => {
    let captured: { batches: { rows: { doc: Record<string, unknown>; table: string }[]; shardKey: string; startLine?: number }[] } | null;
    let orchestrateImport: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        captured = null;
        orchestrateImport = vi.fn(
            async (_namespace: unknown, request: { batches: typeof captured extends null ? never : Exclude<typeof captured, null>["batches"] }) => {
                captured = { batches: request.batches as Exclude<typeof captured, null>["batches"] };

                const inserted: Record<string, number> = {};

                for (const batch of request.batches) {
                    for (const row of batch.rows) {
                        inserted[row.table] = (inserted[row.table] ?? 0) + 1;
                    }
                }

                return {
                    conflicts: 0,
                    errors: [],
                    failed: 0,
                    inserted,
                    ok: request.batches.length,
                    shards: request.batches.map((batch) => ({ result: { conflicts: 0, errors: [], inserted: {} }, shardKey: batch.shardKey })),
                };
            },
        );
    });

    test("rejects without an admin bearer (403)", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/import", { method: "POST" }), {}, fakeCtx);

        expect(response.status).toBe(403);
    });

    test("buckets rows by shard and forwards via orchestrateImport", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "messages" ? { mode: { field: "channelId", kind: "shardBy" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const ndjson = [
            JSON.stringify({ doc: { _id: "u1", email: "a@b.com" }, table: "users" }),
            JSON.stringify({ doc: { _id: "m1", channelId: "c1", text: "hi" }, table: "messages" }),
            JSON.stringify({ doc: { _id: "m2", channelId: "c2", text: "yo" }, table: "messages" }),
            JSON.stringify({ doc: { _id: "u2", email: "c@d.com" }, table: "users" }),
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as { errors: unknown[]; inserted: Record<string, number> };

        expect(body.inserted).toEqual({ messages: 2, users: 2 });
        expect(orchestrateImport).toHaveBeenCalledTimes(1);

        // 3 buckets: __root__ (users), c1 (m1), c2 (m2).
        expect(captured!.batches).toHaveLength(3);

        const shardKeys = captured!.batches.map((b) => b.shardKey).sort();

        expect(shardKeys).toEqual(["__root__", "c1", "c2"]);
    });

    test("reports malformed JSON rows in `errors` but continues", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const ndjson = [
            JSON.stringify({ doc: { _id: "u1", email: "a@b.com" }, table: "users" }),
            "not-json",
            JSON.stringify({ doc: { _id: "u2", email: "c@d.com" }, table: "users" }),
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        const body = (await response.json()) as { errors: { code: string; line: number }[]; inserted: Record<string, number> };

        expect(body.inserted).toEqual({ users: 2 });
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]).toMatchObject({ code: "BAD_ROW", line: 2 });
    });

    test("routes global-table rows through importGlobals", async () => {
        const importGlobals = vi.fn(async (request: { rows: { doc: Record<string, unknown>; table: string }[] }) => ({
            conflicts: 0,
            errors: [],
            inserted: { settings: request.rows.length },
        }));

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            importGlobals: importGlobals as never,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const ndjson = [
            JSON.stringify({ doc: { _id: "g1", value: "v" }, table: "settings" }),
            JSON.stringify({ doc: { _id: "g2", value: "v" }, table: "settings" }),
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        const body = (await response.json()) as { inserted: Record<string, number> };

        expect(body.inserted).toEqual({ settings: 2 });
        expect(importGlobals).toHaveBeenCalledTimes(1);
        expect(orchestrateImport).not.toHaveBeenCalled();
    });

    test("reports global rows as errors when importGlobals is not configured", async () => {
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const ndjson = JSON.stringify({ doc: { _id: "g1" }, table: "settings" });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        const body = (await response.json()) as { errors: { code: string }[] };

        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]!.code).toBe("GLOBAL_NOT_CONFIGURED");
    });
});

describe("import streaming — large body", () => {
    test("handles a 10k-row NDJSON body without crashing", async () => {
        const orchestrateImport = vi.fn(async (_namespace: unknown, request: { batches: { rows: { table: string }[]; shardKey: string }[] }) => {
            const inserted: Record<string, number> = {};

            for (const batch of request.batches) {
                for (const row of batch.rows) {
                    inserted[row.table] = (inserted[row.table] ?? 0) + 1;
                }
            }

            return {
                conflicts: 0,
                errors: [],
                failed: 0,
                inserted,
                ok: request.batches.length,
                shards: [],
            };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: vi.fn() as never,
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const lines: string[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            lines.push(JSON.stringify({ doc: { _id: `u${index}`, email: `u${index}@x.io` }, table: "users" }));
        }

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: lines.join("\n"),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        const body = (await response.json()) as { inserted: Record<string, number> };

        expect(body.inserted).toEqual({ users: 10_000 });
    });

    test("export response body is consumable as a stream", async () => {
        const rows: { doc: Record<string, unknown>; table: string }[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            rows.push({ doc: { _id: `u${index}`, email: `u${index}@x.io` }, table: "users" });
        }

        const orchestrateExport = vi.fn(async () => ({
            failed: 0,
            ok: 1,
            shards: [{ rows, shardKey: "__root__" }],
        }));

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn() as never,
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn() as never,
                orchestrateMigration: vi.fn() as never,
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/export", {
                body: JSON.stringify({ tables: ["users"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        // Read the body incrementally — the test crashes if the runtime
        // materialises a 10k-row body in memory and the `for await` was added
        // for nothing.
        let lineCount = 0;
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let newlineIndex = buffer.indexOf("\n");

            while (newlineIndex !== -1) {
                lineCount += 1;
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
            }
        }

        if (buffer.trim().length > 0) {
            lineCount += 1;
        }

        expect(lineCount).toBe(10_000);
    });
});
