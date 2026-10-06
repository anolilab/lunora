/**
 * The aggregate companion's durable backfill marker on real workerd SQLite: a
 * companion is rebuilt once per shard and trusted by every later ctx-db (codegen
 * builds one per dispatch), until its index definition changes.
 */
import type { SchemaLike, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schemaWith = (where?: Record<string, unknown>): SchemaLike =>
    ({
        tables: {
            todos: {
                aggregateIndexes: [{ by: ["projectId"], name: "byProject", on: "todos", op: "count", where }],
                indexes: [],
                shape: { archived: { kind: "boolean" }, projectId: { kind: "string" } },
            },
        },
    }) as unknown as SchemaLike;

describe("durable object aggregate companion on workerd", () => {
    it("rebuilds once per shard and again only when the index definition changes", async () => {
        expect.assertions(4);

        const stub = env.SHARD.get(env.SHARD.idFromName("aggregate-marker"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            // A value a rebuild would overwrite: reading it back proves the companion was trusted.
            const plant = (): void => {
                state.storage.sql.exec(`UPDATE "todos__agg_byProject" SET "__value__" = 99 WHERE "__key__" = '{"projectId":"p1"}'`);
            };

            runShardMigrations(sql, schemaWith());

            const writer = createShardCtxDb({ schema: schemaWith(), sql });

            await writer.insert("todos", { archived: false, projectId: "p1" });
            await writer.insert("todos", { archived: true, projectId: "p1" });

            await expect(createShardCtxDb({ schema: schemaWith(), sql }).count("todos", { projectId: "p1" })).resolves.toBe(2);

            plant();

            await expect(createShardCtxDb({ schema: schemaWith(), sql }).count("todos", { projectId: "p1" })).resolves.toBe(99);

            const changed = schemaWith({ archived: false });

            runShardMigrations(sql, changed);

            await expect(createShardCtxDb({ schema: changed, sql }).count("todos", { archived: false, projectId: "p1" })).resolves.toBe(1);

            plant();

            await expect(createShardCtxDb({ schema: changed, sql }).count("todos", { archived: false, projectId: "p1" })).resolves.toBe(99);
        });
    });
});
