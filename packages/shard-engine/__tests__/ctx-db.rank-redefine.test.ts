import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import type { RankIndexDefinitionLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Re-declaring a `rankIndex` on a shard that already holds its companion table.
 *
 * The companion's rebuild marker keys on the sort FIELDS, so changing `sortBy`
 * rebuilds the companion; but the table was created `IF NOT EXISTS` with the old
 * `__sort_k<i>__` columns, and the rebuild INSERTs the new ones. Left alone that
 * is a "no such column" from the pre-write hook, so every write to the table
 * fails. A changed sort DIRECTION is not in the marker at all, so the sorted
 * btree kept its old direction under the same name.
 */
const rankIndex = (sortBy: RankIndexDefinitionLike["sortBy"]): RankIndexDefinitionLike => {
    return { name: "leaderboard", on: "players", sortBy };
};

const schemaWith = (index: RankIndexDefinitionLike): SchemaLike => {
    return {
        tables: { players: { indexes: [], rankIndexes: [index], shape: { name: { kind: "string" }, score: { kind: "number" } } } },
    };
};

let harness: ReturnType<typeof createSqliteExec>;

const writerFor = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const seedPlayers = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("players", { _id: "p1", name: "b", score: 10 }, { allowExplicitId: true });
    await writer.insert("players", { _id: "p2", name: "a", score: 10 }, { allowExplicitId: true });
    await writer.insert("players", { _id: "p3", name: "c", score: 30 }, { allowExplicitId: true });
};

describe("rankIndex — redefining sortBy on a populated shard", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("keeps writes working when a sort key is added", async () => {
        expect.assertions(3);

        await seedPlayers(writerFor(schemaWith(rankIndex([{ direction: "desc", field: "score" }]))));

        const widened = writerFor(
            schemaWith(
                rankIndex([
                    { direction: "desc", field: "score" },
                    { direction: "asc", field: "name" },
                ]),
            ),
        );

        await expect(widened.insert("players", { _id: "p4", name: "d", score: 10 }, { allowExplicitId: true })).resolves.toBe("p4");
        // score desc, then name asc: p3(30), then the three 10s ordered a, b, d.
        await expect(widened.rank("players", "leaderboard", { row: "p2" })).resolves.toEqual({ position: 2, total: 4 });
        await expect(widened.rank("players", "leaderboard", { row: "p1" })).resolves.toEqual({ position: 3, total: 4 });
    });

    it("keeps writes working when a sort key is removed", async () => {
        expect.assertions(2);

        await seedPlayers(
            writerFor(
                schemaWith(
                    rankIndex([
                        { direction: "desc", field: "score" },
                        { direction: "asc", field: "name" },
                    ]),
                ),
            ),
        );

        const narrowed = writerFor(schemaWith(rankIndex([{ direction: "desc", field: "score" }])));

        await expect(narrowed.insert("players", { _id: "p4", name: "d", score: 50 }, { allowExplicitId: true })).resolves.toBe("p4");
        await expect(narrowed.rank("players", "leaderboard", { row: "p4" })).resolves.toEqual({ position: 1, total: 4 });
    });

    it("reshapes the sorted btree when only a sort direction changes", async () => {
        expect.assertions(2);

        await seedPlayers(writerFor(schemaWith(rankIndex([{ direction: "desc", field: "score" }]))));

        const btreeSql = (): string =>
            String(harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'players__rank_leaderboard__btree'`)[0]?.["sql"]);

        expect(btreeSql()).toContain("DESC");

        const flipped = writerFor(schemaWith(rankIndex([{ direction: "asc", field: "score" }])));

        expect(btreeSql()).not.toContain("DESC");

        await flipped.insert("players", { _id: "p4", name: "d", score: 5 }, { allowExplicitId: true });
    });
});
