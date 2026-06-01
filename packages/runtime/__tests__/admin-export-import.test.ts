import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, ShardingInfo } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

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

describe("createWorker — admin export endpoint", () => {
    it("rejects without a configured admin token (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        expect(response.status).toBe(403);
    });

    it("rejects without an authorization header (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/export", { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("rejects non-POST (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/export"), {}, fakeContext);

        expect(response.status).toBe(405);
    });

    it("streams NDJSON from orchestrateExport", async () => {
        expect.assertions(4);

        const orchestrateExport = vi.fn<(namespace: unknown, request: { tables: ReadonlyArray<string> }) => Promise<unknown>>(async (_namespace, _request) => {
            return {
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
            };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/x-ndjson");

        const text = await response.text();
        const lines = text.trim().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]!)).toEqual({ doc: { _id: "u1", email: "a@b.com" }, table: "users" });
    });

    it("streams D1 globals when exportGlobals is configured", async () => {
        expect.assertions(2);

        const orchestrateExport = vi.fn<(namespace: unknown, request: { tables: ReadonlyArray<string> }) => Promise<unknown>>(async (_namespace, _request) => {
            return {
                failed: 0,
                ok: 0,
                shards: [],
            };
        });

        const exportGlobals = vi.fn<() => AsyncGenerator<{ doc: Record<string, unknown>; table: string }>>(async function* globalsIter() {
            yield { doc: { _id: "g1" }, table: "settings" };
            yield { doc: { _id: "g2" }, table: "settings" };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            exportGlobals: exportGlobals as never,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
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
        orchestrateImport = vi.fn<(namespace: unknown, request: { batches: Exclude<typeof captured, null>["batches"] }) => Promise<unknown>>(
            async (_namespace: unknown, request: { batches: typeof captured extends null ? never : Exclude<typeof captured, null>["batches"] }) => {
                captured = { batches: request.batches };

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
                    shards: request.batches.map((batch) => {
                        return { result: { conflicts: 0, errors: [], inserted: {} }, shardKey: batch.shardKey };
                    }),
                };
            },
        );
    });

    it("rejects without an admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_cirrus/admin/import", { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("buckets rows by shard and forwards via orchestrateImport", async () => {
        expect.assertions(5);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { errors: unknown[]; inserted: Record<string, number> } = await response.json();

        expect(body.inserted).toEqual({ messages: 2, users: 2 });
        expect(orchestrateImport).toHaveBeenCalledTimes(1);

        // 3 buckets: __root__ (users), c1 (m1), c2 (m2).
        expect(captured!.batches).toHaveLength(3);

        const shardKeys = captured!.batches.map((batch) => batch.shardKey).toSorted((a, b) => a.localeCompare(b));

        expect(shardKeys).toEqual(["__root__", "c1", "c2"]);
    });

    it("reports malformed JSON rows in `errors` but continues", async () => {
        expect.assertions(3);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        const body: { errors: { code: string; line: number }[]; inserted: Record<string, number> } = await response.json();

        expect(body.inserted).toEqual({ users: 2 });
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]).toMatchObject({ code: "BAD_ROW", line: 2 });
    });

    it("routes global-table rows through importGlobals", async () => {
        expect.assertions(3);

        const importGlobals = vi.fn<(request: { rows: { doc: Record<string, unknown>; table: string }[] }) => Promise<unknown>>(async (request) => {
            return {
                conflicts: 0,
                errors: [],
                inserted: { settings: request.rows.length },
            };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            importGlobals: importGlobals as never,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        const body: { inserted: Record<string, number> } = await response.json();

        expect(body.inserted).toEqual({ settings: 2 });
        expect(importGlobals).toHaveBeenCalledTimes(1);
        expect(orchestrateImport).not.toHaveBeenCalled();
    });

    it("reports global rows as errors when importGlobals is not configured", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        const body: { errors: { code: string }[] } = await response.json();

        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]!.code).toBe("GLOBAL_NOT_CONFIGURED");
    });
});

describe("import streaming — large body", () => {
    it("handles a 10k-row NDJSON body without crashing", async () => {
        expect.hasAssertions();

        const orchestrateImport = vi.fn<(namespace: unknown, request: { batches: { rows: { table: string }[]; shardKey: string }[] }) => Promise<unknown>>(
            async (_namespace, request) => {
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
            },
        );

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const lines: string[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            lines.push(JSON.stringify({ doc: { _id: `u${String(index)}`, email: `u${String(index)}@x.io` }, table: "users" }));
        }

        const response = await worker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: lines.join("\n"),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        const body: { inserted: Record<string, number> } = await response.json();

        expect(body.inserted).toEqual({ users: 10_000 });
    });

    it("export response body is consumable as a stream", async () => {
        expect.hasAssertions();

        const rows: { doc: Record<string, unknown>; table: string }[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            rows.push({ doc: { _id: `u${String(index)}`, email: `u${String(index)}@x.io` }, table: "users" });
        }

        const orchestrateExport = vi.fn<() => Promise<unknown>>(async () => {
            return {
                failed: 0,
                ok: 1,
                shards: [{ rows, shardKey: "__root__" }],
            };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
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
            fakeContext,
        );

        // Read the body incrementally — the test crashes if the runtime
        // materialises a 10k-row body in memory and the `for await` was added
        // for nothing.
        let lineCount = 0;
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            // eslint-disable-next-line no-await-in-loop -- streaming reader: each chunk must be read sequentially
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

        // Count any trailing (newline-less) final line without an `if`.
        lineCount += Number(buffer.trim().length > 0);

        expect(lineCount).toBe(10_000);
    });
});
