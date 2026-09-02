import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformSync } from "esbuild";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike, ShardingInfo } from "../src/create-worker";
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

/**
 * A chunked request body that streams just over the 1 MiB `MAX_BODY_BYTES`
 * cap with no `Content-Length`, so only the byte-budgeted reader can reject it.
 */
const oversizedStream = (): ReadableStream<Uint8Array> => {
    const chunk = new Uint8Array(256 * 1024).fill(120); // 'x'
    let sent = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent >= 5) {
                controller.close();

                return;
            }

            sent += 1;
            controller.enqueue(chunk); // 5 × 256 KiB = 1.25 MiB > 1 MiB cap
        },
    });
};

describe("createWorker — admin export endpoint", () => {
    it("rejects without a configured admin token (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/export", {
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/export", { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("rejects non-POST (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/export"), {}, fakeContext);

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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/export", {
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/export", {
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(new Request("https://app.example/_lunora/admin/import", { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports `received` and warns when no resolveTableSharding is configured", async () => {
        expect.assertions(4);

        // `errors: []` + `conflicts: 0` together assert nothing went wrong, and
        // an empty `inserted` map is also what a legitimately empty batch
        // returns — so an import that was structurally unable to write looked
        // identical to one that had nothing to do, and a migration script could
        // report "imported N rows" against an empty database.
        //
        // Without `resolveTableSharding` the worker also cannot recognise a
        // `.global()` table, so every row goes to the default shard AND the
        // `GLOBAL_NOT_CONFIGURED` error never fires. Two missing options
        // cancelling out each other's diagnostics is the whole bug.
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const ndjson = [
            JSON.stringify({ doc: { _id: "u1", email: "a@b.com" }, table: "users" }),
            JSON.stringify({ doc: { _id: "u2", email: "c@d.com" }, table: "users" }),
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { received: number; warnings?: string[] } = await response.json();

        expect(body.received).toBe(2);
        expect(body.warnings).toHaveLength(1);
        expect(body.warnings?.[0]).toContain("resolveTableSharding");
    });

    it("counts `received` once per row even when every row errors", async () => {
        expect.assertions(3);

        // `received` must be the number of rows READ, not a sum over the buckets:
        // the error list is appended to during fan-out, so reconstructing the
        // total afterwards counts each failed row twice — once in its bucket and
        // again as an error. Every row here fails, which is where 2N shows up.
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            // Recognises `users` as global, but no `importGlobals` is wired — so
            // every row lands on the GLOBAL_NOT_CONFIGURED path.
            resolveTableSharding: (): ShardingInfo => {
                return { mode: { kind: "global" } };
            },
            shardDO: noopNamespace,
        });

        const ndjson = [
            JSON.stringify({ doc: { _id: "u1", email: "a@b.com" }, table: "users" }),
            JSON.stringify({ doc: { _id: "u2", email: "c@d.com" }, table: "users" }),
            JSON.stringify({ doc: { _id: "u3", email: "e@f.com" }, table: "users" }),
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        const body: { errors: unknown[]; inserted: Record<string, number>; received: number } = await response.json();

        expect(body.errors).toHaveLength(3);
        // Three rows in, three rows counted — not six.
        expect(body.received).toBe(3);
        expect(body.inserted).toEqual({});
    });

    it("buckets rows by shard and forwards via orchestrateImport", async () => {
        expect.assertions(5);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
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
            new Request("https://app.example/_lunora/admin/import", {
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
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
            new Request("https://app.example/_lunora/admin/import", {
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

    it("attributes row errors to the physical source line across blank lines", async () => {
        expect.assertions(3);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        // Leading blank line (line 1) + interior blank line (line 4). The bad
        // row sits on physical line 5; counting only non-blank lines would
        // mis-report it as line 3.
        const ndjson = [
            "",
            JSON.stringify({ doc: { _id: "u1", email: "a@b.com" }, table: "users" }),
            JSON.stringify({ doc: { _id: "u2", email: "c@d.com" }, table: "users" }),
            "",
            "not-json",
        ].join("\n");

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
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
        expect(body.errors[0]).toMatchObject({ code: "BAD_ROW", line: 5 });
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
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
            new Request("https://app.example/_lunora/admin/import", {
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

    it("attributes the true physical line to interspersed global rows", async () => {
        expect.assertions(1);

        let capturedRows: { doc: Record<string, unknown>; line: number; table: string }[] = [];
        const importGlobals = vi.fn<(request: { rows: { doc: Record<string, unknown>; line: number; table: string }[] }) => Promise<unknown>>(
            async (request) => {
                capturedRows = request.rows;

                return { conflicts: 0, errors: [], inserted: { settings: request.rows.length } };
            },
        );

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            importGlobals: importGlobals as never,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        // Global row on line 1, a shard row on line 2, a second global row on line
        // 3 — the second global row's true source line is 3, not 2.
        const ndjson = [
            JSON.stringify({ doc: { _id: "g1" }, table: "settings" }),
            JSON.stringify({ doc: { _id: "s1" }, table: "messages" }),
            JSON.stringify({ doc: { _id: "g2" }, table: "settings" }),
        ].join("\n");

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(capturedRows.map((row) => row.line)).toEqual([1, 3]);
    });

    it("reports global rows as errors when importGlobals is not configured", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "settings" ? { mode: { kind: "global" } } : { mode: { kind: "root" } },
            shardDO: noopNamespace,
        });

        const ndjson = JSON.stringify({ doc: { _id: "g1" }, table: "settings" });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
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

/**
 * The `backup` registry item's scheduled snapshot, restored through this endpoint.
 *
 * The item writes NDJSON to R2 and `lunora backup restore` feeds that object
 * straight back here — but nothing ever ran the two halves against each other,
 * which is how the snapshot shipped framed by `{"__table":…}` header lines above
 * bare rows. This reader needs `table` and `doc` on EVERY line, so a header-framed
 * snapshot restored zero rows and the operator found out mid-incident.
 *
 * The serialiser is lifted out of the shipped item and CALLED rather than
 * re-typed here, so the assertion is over what the item actually emits.
 */
describe("backup registry snapshot → admin import", () => {
    const scratch = mkdtempSync(join(tmpdir(), "lunora-backup-item-"));
    const itemPath = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "registry", "backup", "backup.ts");

    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    /**
     * `toNdjson` as the shipped registry item defines it, compiled and imported as
     * a real module.
     *
     * Lifting the item's own expression is the point: a re-typed copy here would
     * keep passing after the item drifted, which is exactly the gap that let the
     * header-framed shape ship.
     */
    const itemToNdjson = async (): Promise<(table: string, rows: ReadonlyArray<Record<string, unknown>>) => string> => {
        const match = /^const toNdjson = (.*);$/mu.exec(readFileSync(itemPath, "utf8"));

        if (match?.[1] === undefined) {
            throw new Error("could not locate `toNdjson` in registry/backup/backup.ts");
        }

        const compiled = transformSync(`export const toNdjson = ${match[1]};`, { loader: "ts" }).code;
        const file = join(scratch, `to-ndjson-${randomUUID()}.mjs`);

        writeFileSync(file, compiled);

        const loaded = (await import(pathToFileURL(file).href)) as { toNdjson: (table: string, rows: ReadonlyArray<Record<string, unknown>>) => string };

        return loaded.toNdjson;
    };

    it("restores every row of a snapshot the registry item produced", async () => {
        expect.assertions(3);

        const toNdjson = await itemToNdjson();
        const imported: { doc: Record<string, unknown>; table: string }[] = [];
        const orchestrateImport = vi.fn<
            (_namespace: unknown, request: { batches: { rows: { doc: Record<string, unknown>; table: string }[]; shardKey: string }[] }) => Promise<unknown>
        >(async (_namespace: unknown, request: { batches: { rows: { doc: Record<string, unknown>; table: string }[]; shardKey: string }[] }) => {
            const inserted: Record<string, number> = {};

            for (const batch of request.batches) {
                for (const row of batch.rows) {
                    imported.push(row);
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
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            resolveTableSharding: (): ShardingInfo => {
                return { mode: { kind: "root" } };
            },
            shardDO: noopNamespace,
        });

        // The item's own framing: per-table chunks joined by newlines, one
        // trailing newline (`registry/backup/backup.ts`, the `snapshot` action).
        const body = `${[
            toNdjson("messages", [{ _id: "m1", body: "hi" }]),
            toNdjson("users", [
                { _id: "u1", name: "Ada" },
                { _id: "u2", name: "Grace" },
            ]),
        ]
            .filter((chunk) => chunk.length > 0)
            .join("\n")}\n`;

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        const result: { errors: unknown[]; inserted: Record<string, number> } = await response.json();

        // A header-framed snapshot lands here as three `BAD_ROW: row is missing
        // \`table\`` errors and an empty `inserted` — a restore of nothing.
        expect(result.errors).toStrictEqual([]);
        expect(result.inserted).toStrictEqual({ messages: 1, users: 2 });
        expect(imported.map((row) => row.table)).toStrictEqual(["messages", "users", "users"]);
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: orchestrateImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const lines: string[] = [];

        for (let index = 0; index < 10_000; index += 1) {
            lines.push(JSON.stringify({ doc: { _id: `u${String(index)}`, email: `u${String(index)}@x.io` }, table: "users" }));
        }

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
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
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: orchestrateExport as never,
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/export", {
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

describe("admin sync (CDC streaming export)", () => {
    it("returns per-shard pages plus the global page and forwards the cursor map", async () => {
        expect.assertions(4);

        const orchestrateCdcSync = vi.fn<
            (
                namespace: unknown,
                request: { cursors?: Record<string, number> },
            ) => Promise<{
                failed: number;
                ok: number;
                shards: { changes: { id: string; op: string; seq: number }[]; cursor: number; shardKey: string }[];
            }>
        >(async (_namespace, _request) => {
            return {
                failed: 0,
                ok: 1,
                shards: [{ changes: [{ id: "m1", op: "insert", seq: 5 }], cursor: 5, shardKey: "c1" }],
            };
        });
        const syncGlobals = vi.fn<() => Promise<{ changes: { id: string; op: string; seq: number }[]; cursor: number }>>(async () => {
            return { changes: [{ id: "u1", op: "insert", seq: 2 }], cursor: 2 };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
            syncGlobals,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/sync", {
                body: JSON.stringify({ cursors: { c1: 4 }, globalCursor: 1, tables: ["messages"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ global: { cursor: number }; shards: { cursor: number; shardKey: string }[] }>();

        expect(body.shards[0]).toMatchObject({ cursor: 5, shardKey: "c1" });
        expect(body.global.cursor).toBe(2);
        // The caller's per-shard cursor map reaches the coordinator verbatim.
        expect(orchestrateCdcSync.mock.calls[0]?.[1]).toMatchObject({ cursors: { c1: 4 } });
    });

    it("omits the global page when syncGlobals is not configured", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: async () => {
                    return { failed: 0, ok: 0, shards: [] };
                },
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/sync", {
                body: JSON.stringify({}),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        const body = await response.json<{ global?: unknown }>();

        expect(response.status).toBe(200);
        expect(body.global).toBeUndefined();
    });

    it("rejects an over-cap chunked body with 413", async () => {
        expect.assertions(1);

        const orchestrateCdcSync = vi.fn<() => never>();

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync,
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/sync", {
                // Streamed body has no Content-Length, so the header fast-path
                // can't see the size — the byte-budgeted reader must catch it.
                body: oversizedStream(),
                // @ts-expect-error -- duplex is required by the fetch spec for a streaming body but missing from the lib types here
                duplex: "half",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
    });
});

describe("createWorker — jurisdiction pins the export/import fan-out", () => {
    /** A namespace whose `.jurisdiction()` returns a distinct sentinel subnamespace. */
    const pinningNamespace = (): { jurisdictionCalls: string[]; namespace: ShardNamespaceLike; pinned: ShardNamespaceLike } => {
        const jurisdictionCalls: string[] = [];
        const pinned: ShardNamespaceLike = {
            get: () => {
                return { fetch: async () => new Response("pinned", { status: 200 }) };
            },
            idFromName: (name) => {
                return { __pinned: name };
            },
        };

        return {
            jurisdictionCalls,
            namespace: {
                get: () => {
                    throw new Error("export/import must resolve via the jurisdiction subnamespace, not the raw binding");
                },
                idFromName: () => {
                    throw new Error("export/import must resolve via the jurisdiction subnamespace, not the raw binding");
                },
                jurisdiction: (j) => {
                    jurisdictionCalls.push(j);

                    return pinned;
                },
            },
            pinned,
        };
    };

    const coordinatorWith = (overrides: Record<string, unknown>): Record<string, unknown> => {
        return {
            fanOut: vi.fn<() => never>(),
            orchestrateApplyCdc: vi.fn<() => never>(),
            orchestrateCdcSync: vi.fn<() => never>(),
            orchestrateExport: vi.fn<() => never>(),
            orchestrateImport: vi.fn<() => never>(),
            orchestrateMigration: vi.fn<() => never>(),
            orchestrateRank: vi.fn<() => never>(),
            orchestrateRankPage: vi.fn<() => never>(),
            orchestrateShardTraffic: vi.fn<() => never>(),
            registry: {},
            ...overrides,
        };
    };

    it("export passes the jurisdiction-pinned subnamespace to orchestrateExport", async () => {
        expect.assertions(2);

        const { jurisdictionCalls, namespace, pinned } = pinningNamespace();
        const orchestrateExport = vi.fn<(ns: unknown) => Promise<unknown>>(async () => {
            return { failed: 0, ok: 0, shards: [] };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            jurisdiction: "us",
            queryCoordinator: coordinatorWith({ orchestrateExport }) as never,
            shardDO: namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/export", {
                body: JSON.stringify({ tables: ["users"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        // The namespace is pinned ONCE at the worker boundary and the pinned
        // subnamespace is threaded into export-stream — so `.jurisdiction()` is
        // requested exactly once, and that subnamespace reaches orchestrateExport.
        expect(jurisdictionCalls).toStrictEqual(["us"]);
        expect(orchestrateExport.mock.calls[0]?.[0]).toBe(pinned);
    });

    it("import passes the jurisdiction-pinned subnamespace to orchestrateImport", async () => {
        expect.assertions(2);

        const { jurisdictionCalls, namespace, pinned } = pinningNamespace();
        const orchestrateImport = vi.fn<(ns: unknown) => Promise<unknown>>(async () => {
            return { conflicts: 0, errors: [], failed: 0, inserted: {}, ok: 1, shards: [] };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            jurisdiction: "eu",
            queryCoordinator: coordinatorWith({ orchestrateImport }) as never,
            shardDO: namespace,
        });

        await worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: JSON.stringify({ doc: { _id: "u1" }, table: "users" }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(jurisdictionCalls).toStrictEqual(["eu"]);
        expect(orchestrateImport.mock.calls[0]?.[0]).toBe(pinned);
    });
});

describe("admin apply (CDC replay)", () => {
    it("replays per-shard batches plus globals and sums the applied counts", async () => {
        expect.assertions(3);

        const orchestrateApplyCdc = vi.fn<
            (namespace: unknown, request: { batches: ReadonlyArray<unknown> }) => Promise<{ applied: number; failed: number; ok: number }>
        >(async (_namespace, request) => {
            return { applied: request.batches.length, failed: 0, ok: request.batches.length };
        });
        const applyGlobals = vi.fn<() => Promise<number>>(async () => 2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            applyGlobals,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc,
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/apply", {
                body: JSON.stringify({
                    batches: [
                        { changes: [{ id: "a" }], shardKey: "c1" },
                        { changes: [{ id: "b" }], shardKey: "c2" },
                    ],
                    globalChanges: [{ id: "g" }],
                }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body = await response.json<{ applied: number }>();

        // 2 shard batches (mock returns batches.length) + 2 globals.
        expect(body.applied).toBe(4);
        expect(applyGlobals).toHaveBeenCalledTimes(1);
    });

    it("rejects an over-cap chunked body with 413", async () => {
        expect.assertions(1);

        const orchestrateApplyCdc = vi.fn<() => never>();

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc,
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: vi.fn<() => never>(),
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(
            new Request("https://app.example/_lunora/admin/apply", {
                body: oversizedStream(),
                // @ts-expect-error -- duplex is required by the fetch spec for a streaming body but missing from the lib types here
                duplex: "half",
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(413);
    });
});

describe("admin import — a shard the fan-out never reached", () => {
    /** Coordinator whose import fan-out loses shard B: it contributes nothing to `inserted`/`errors`, only to `failed`/`shards[].error`. */
    const partialImport = vi.fn<(namespace: unknown, request: { batches: { rows: { table: string }[]; shardKey: string }[] }) => Promise<unknown>>(async () => {
        return {
            conflicts: 0,
            errors: [],
            failed: 1,
            inserted: { users: 2 },
            ok: 1,
            shards: [
                { result: { conflicts: 0, errors: [], inserted: { users: 2 } }, shardKey: "shard-a" },
                { error: { message: "shard RPC timed out", timedOut: true }, shardKey: "shard-b" },
            ],
        };
    });

    const postImport = (worker: { fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> }): Promise<Response> =>
        worker.fetch(
            new Request("https://app.example/_lunora/admin/import", {
                body: [
                    JSON.stringify({ doc: { _id: "u1" }, table: "users" }),
                    JSON.stringify({ doc: { _id: "u2" }, table: "users" }),
                    JSON.stringify({ doc: { _id: "u3" }, table: "users" }),
                ].join("\n"),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeContext,
        );

    it("surfaces the dead shard and answers 207 instead of reporting a clean 200", async () => {
        expect.assertions(4);

        // `mergeImportResult` folded only `{ inserted, errors, conflicts }`, and
        // `rollUpImport` records a dead shard ONLY in `failed`/`shards[].error` —
        // so a partial write returned `200 { errors: [], conflicts: 0 }` with a
        // slice of the dataset silently missing.
        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: partialImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await postImport(worker);

        expect(response.status).toBe(207);

        const body: { failed: { message: string; shardKey: string; timedOut: boolean }[]; inserted: Record<string, number>; received: number } =
            await response.json();

        expect(body.failed).toStrictEqual([{ message: "shard RPC timed out", shardKey: "shard-b", timedOut: true }]);
        // `inserted` is a floor, not a result — `received` is the honest denominator.
        expect(body.inserted).toEqual({ users: 2 });
        expect(body.received).toBe(3);
    });

    it("stays 200 with an empty `failed` when every shard answered", async () => {
        expect.assertions(2);

        const cleanImport = vi.fn<() => Promise<unknown>>(async () => {
            return {
                conflicts: 0,
                errors: [],
                failed: 0,
                inserted: { users: 3 },
                ok: 1,
                shards: [{ result: { conflicts: 0, errors: [], inserted: { users: 3 } }, shardKey: "shard-a" }],
            };
        });

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: {
                fanOut: vi.fn<() => never>(),
                orchestrateApplyCdc: vi.fn<() => never>(),
                orchestrateCdcSync: vi.fn<() => never>(),
                orchestrateExport: vi.fn<() => never>(),
                orchestrateImport: cleanImport as never,
                orchestrateMigration: vi.fn<() => never>(),
                orchestrateRank: vi.fn<() => never>(),
                orchestrateRankPage: vi.fn<() => never>(),
                orchestrateShardTraffic: vi.fn<() => never>(),
                registry: {} as never,
            },
            shardDO: noopNamespace,
        });

        const response = await postImport(worker);

        expect(response.status).toBe(200);

        const body: { failed: unknown[] } = await response.json();

        expect(body.failed).toStrictEqual([]);
    });
});
