/**
 * The aggregate companion's durable backfill marker on real workerd SQLite: a
 * companion is rebuilt once per shard and trusted by every later ctx-db (codegen
 * builds one per dispatch), until its index definition changes or the markers
 * are cleared. Rank companions follow the same rule.
 */
import type { SchemaLike, SqlExec } from "@lunora/shard-engine";
import { clearCompanionSignatures, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
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
    it("rebuilds once per shard and again only when the index definition changes or the markers are cleared", async () => {
        expect.assertions(5);

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

            // The admin escape hatch: forgetting the markers makes the next touch rebuild.
            clearCompanionSignatures(sql);

            await expect(createShardCtxDb({ schema: changed, sql }).count("todos", { archived: false, projectId: "p1" })).resolves.toBe(1);
        });
    });

    it("rebuilds a rank companion once per shard, and again once its index is re-declared", async () => {
        expect.assertions(3);

        const stub = env.SHARD.get(env.SHARD.idFromName("rank-marker"));
        const withRank = {
            tables: {
                scores: {
                    indexes: [],
                    rankIndexes: [{ name: "byScore", on: "scores", sortBy: [{ direction: "desc", field: "score" }] }],
                    shape: { score: { kind: "number" } },
                },
            },
        } as unknown as SchemaLike;
        const without = { tables: { scores: { indexes: [], shape: { score: { kind: "number" } } } } } as unknown as SchemaLike;

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as SqlExec;

            runShardMigrations(sql, withRank);

            const writer = createShardCtxDb({ schema: withRank, sql });

            await writer.insert("scores", { _id: "s1", score: 10 }, { allowExplicitId: true });
            await writer.insert("scores", { _id: "s2", score: 20 }, { allowExplicitId: true });

            await expect(createShardCtxDb({ schema: withRank, sql }).rank("scores", "byScore", { row: "s1" })).resolves.toEqual({ position: 2, total: 2 });

            // Removing an entry a rebuild would restore: the shorter total proves the companion was trusted.
            state.storage.sql.exec(`DELETE FROM "scores__rank_byScore" WHERE "__id__" = 's2'`);

            await expect(createShardCtxDb({ schema: withRank, sql }).rank("scores", "byScore", { row: "s1" })).resolves.toEqual({ position: 1, total: 1 });

            // Undeclared then re-declared: the prune drops the marker, so it rebuilds.
            runShardMigrations(sql, without);
            runShardMigrations(sql, withRank);

            await expect(createShardCtxDb({ schema: withRank, sql }).rank("scores", "byScore", { row: "s1" })).resolves.toEqual({ position: 2, total: 2 });
        });
    });
});
