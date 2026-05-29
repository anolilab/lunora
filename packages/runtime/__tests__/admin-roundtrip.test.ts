/**
 * End-to-end roundtrip: a worker with the new admin endpoints wired up to a
 * 3-shard cluster of in-memory SQLite ShardDOs. Exports a seeded dataset,
 * imports it into a fresh cluster, and asserts shard-routing was preserved.
 */
import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, RunShardExportArgs, RunShardImportArgs, SchemaLike, ShardDOState } from "@cirrus/do";
import { createShardCtxDb, exportShardRows, importShardRows, runShardMigrations, ShardDO } from "@cirrus/do";
import { describe, expect, test } from "vitest";

import type { ExecutionContextLike, ShardingInfo } from "../src/create-worker.js";
import { createWorker } from "../src/create-worker.js";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

const ADMIN_TOKEN = "roundtrip-admin";

const minimalParser = (kind: string) => ({
    kind,
    parse(value: unknown) {
        if (kind === "string" && typeof value !== "string") {
            throw new Error("expected string");
        }

        return value;
    },
});

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [],
            shape: { channelId: minimalParser("string"), text: minimalParser("string") },
            shardMode: { field: "channelId", kind: "shardBy" } as never,
        },
    },
};

const buildSqliteSql = (): { close: () => void; sql: ShardDOState["storage"]["sql"] } => {
    const database = new DatabaseSync(":memory:");
    const runner = (query: string, ...parameters: unknown[]) => {
        const statement = database.prepare(query);
        const rows = statement.all(...(parameters as never[])) as Record<string, unknown>[];

        return {
            [Symbol.iterator]() {
                return rows[Symbol.iterator]();
            },
            one() {
                if (rows.length !== 1) {
                    throw new Error("expected one row");
                }

                return rows[0]!;
            },
            toArray() {
                return rows;
            },
        };
    };
    const sqlSurface: Record<string, unknown> = {};

    Object.defineProperty(sqlSurface, "exec", { value: runner, writable: false });

    return {
        close: () => {
            database.close();
        },
        sql: sqlSurface as ShardDOState["storage"]["sql"],
    };
};

class TestShard extends ShardDO {
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc not used in this test");
    }

    protected override async runShardExport(args: RunShardExportArgs) {
        const writer = createShardCtxDb({ schema, sql: this.sql as never });
        const rows: { doc: Record<string, unknown>; table: string }[] = [];

        for await (const row of exportShardRows(writer, schema, args)) rows.push(row);

        return rows;
    }

    protected override async runShardImport(args: RunShardImportArgs) {
        const writer = createShardCtxDb({
            broadcast: (delta) => {
                this.recordChangedTable(delta.table);
            },
            schema,
            sql: this.sql as never,
        });

        return importShardRows(writer, schema, args);
    }
}

const fakeCtx: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const buildCluster = (shardKeys: string[]) => {
    const shards = new Map<string, { close: () => void; shard: TestShard; writer: DatabaseWriterLike }>();

    for (const key of shardKeys) {
        const { close, sql } = buildSqliteSql();

        runShardMigrations(sql as never, schema);
        const state: ShardDOState = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql },
        };
        const shard = new TestShard(state, { CIRRUS_ADMIN_TOKEN: ADMIN_TOKEN });
        const writer = createShardCtxDb({ schema, sql: sql as never });

        shards.set(key, { close, shard, writer });
    }

    const namespace: ShardNamespaceLike = {
        get(id) {
            const name = (id as { __name: string }).__name;
            const shard = shards.get(name);

            if (!shard) {
                throw new Error(`unknown shard "${name}"`);
            }

            return {
                async fetch(request: Request) {
                    return shard.shard.fetch(request);
                },
            };
        },
        idFromName: (name) => ({ __name: name }),
    };

    return { namespace, shards };
};

describe("admin roundtrip — 3 shards", () => {
    test("export → import across 3 shard buckets roundtrips identically", async () => {
        const channelKeys = ["c1", "c2", "c3"];
        const sourceCluster = buildCluster(channelKeys);

        for (const key of channelKeys) {
            const { writer } = sourceCluster.shards.get(key)!;

            for (let index = 1; index <= 4; index += 1) {
                await writer.insert("messages", {
                    _id: `${key}-m${String(index)}`,
                    channelId: key,
                    text: `${key} msg ${String(index)}`,
                });
            }
        }

        const registry = createStaticShardRegistry({ messages: channelKeys });
        const coordinator = createQueryCoordinator({ registry });

        const sourceWorker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: coordinator,
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "messages" ? { mode: { field: "channelId", kind: "shardBy" } } : undefined,
            shardDO: sourceCluster.namespace,
        });

        const exportResponse = await sourceWorker.fetch(
            new Request("https://app.example/_cirrus/admin/export", {
                body: JSON.stringify({ tables: ["messages"] }),
                headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(exportResponse.status).toBe(200);

        const ndjson = await exportResponse.text();
        const lines = ndjson.trim().split("\n");

        expect(lines).toHaveLength(12);

        const targetCluster = buildCluster(channelKeys);
        const targetCoordinator = createQueryCoordinator({ registry });

        const targetWorker = createWorker({
            adminToken: ADMIN_TOKEN,
            queryCoordinator: targetCoordinator,
            resolveTableSharding: (table: string): ShardingInfo | undefined =>
                table === "messages" ? { mode: { field: "channelId", kind: "shardBy" } } : undefined,
            shardDO: targetCluster.namespace,
        });

        const importResponse = await targetWorker.fetch(
            new Request("https://app.example/_cirrus/admin/import", {
                body: ndjson,
                headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/x-ndjson" },
                method: "POST",
            }),
            {},
            fakeCtx,
        );

        expect(importResponse.status).toBe(200);

        const body = (await importResponse.json()) as { errors: unknown[]; inserted: Record<string, number> };

        expect(body.errors).toEqual([]);
        expect(body.inserted).toEqual({ messages: 12 });

        for (const key of channelKeys) {
            const { writer } = targetCluster.shards.get(key)!;
            const page = await writer.findMany("messages", {});

            expect(page.page).toHaveLength(4);

            for (const doc of page.page) {
                expect(doc["channelId"]).toBe(key);
            }
        }

        for (const { close } of sourceCluster.shards.values()) close();

        for (const { close } of targetCluster.shards.values()) close();
    });
});
