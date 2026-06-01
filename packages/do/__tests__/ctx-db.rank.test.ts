import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { backfillRankIndexes, createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import type { RankIndexDefinitionLike } from "../src/rank.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the rank-index runtime — trigger-maintained sorted companions,
 * partition semantics, RLS coupling seam, lazy/explicit backfill — against a
 * real SQLite engine.
 */

const byChannelByCreation: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "messages",
    partitionBy: ["channelId"],
    sortBy: [{ direction: "asc", field: "_creationTime" }],
};

const byScoreDesc: RankIndexDefinitionLike = {
    name: "leaderboard",
    on: "messages",
    sortBy: [{ direction: "desc", field: "score" }],
};

const activeByChannel: RankIndexDefinitionLike = {
    name: "activeByChannel",
    on: "messages",
    partitionBy: ["channelId"],
    sortBy: [{ direction: "asc", field: "_creationTime" }],
    where: { archived: false },
};

const makeSchema = (...indexes: RankIndexDefinitionLike[]): SchemaLike => ({
    tables: {
        messages: {
            indexes: [],
            rankIndexes: indexes,
            shape: {
                archived: { kind: "boolean" },
                channelId: { kind: "string" },
                score: { kind: "number" },
            },
        },
    },
});

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("rankIndex runtime", () => {
    test("rank() returns 1-based position + partition total within partition", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 150, _id: "m4", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("messages", "byChannel", { row: "m3" })).resolves.toEqual({ position: 3, total: 3 });
        await expect(writer.rank("messages", "byChannel", { row: "m4" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("rank() accepts a row document instead of an id", async () => {
        const writer = setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 100 }, { allowExplicitId: true });

        const doc = await writer.get("m2");

        await expect(writer.rank("messages", "leaderboard", { row: doc! })).resolves.toEqual({ position: 1, total: 2 });
    });

    test("rank() returns null when the row isn't in the index", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { row: "does-not-exist" })).resolves.toBeNull();
    });

    test("desc sort puts the highest value first", async () => {
        const writer = setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "leaderboard", { row: "m2" })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m3" })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m1" })).resolves.toEqual({ position: 3, total: 3 });
    });

    test("insert / update / delete maintains the rank companion atomically", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 2 });

        // Move m2 to channel c2 — position resets within c2; c1 now has just m1.
        await writer.patch("m2", { channelId: "c2" });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 1, total: 1 });

        // Delete m1.
        await writer.delete("m1");

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toBeNull();
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("static `where` filters rows out of the index", async () => {
        const writer = setupWriter(makeSchema(activeByChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: true, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "activeByChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 2 });
        await expect(writer.rank("messages", "activeByChannel", { row: "m2" })).resolves.toBeNull();
        await expect(writer.rank("messages", "activeByChannel", { row: "m3" })).resolves.toEqual({ position: 2, total: 2 });

        // Archive m1 — drops out of the index; m3 now position 1 of 1.
        await writer.patch("m1", { archived: true });

        await expect(writer.rank("messages", "activeByChannel", { row: "m1" })).resolves.toBeNull();
        await expect(writer.rank("messages", "activeByChannel", { row: "m3" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("rank() returns null when the requested partition doesn't match the row's stored partition", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        // m1 lives in c1; asking for it in c2 returns null (the index doesn't
        // cross partition boundaries).
        await expect(writer.rank("messages", "byChannel", { row: "m1", where: { channelId: "c2" } })).resolves.toBeNull();
    });

    test("baseWhere participates identically to aggregates", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        // baseWhere scopes the partition the same way `where` does.
        await expect(writer.rank("messages", "byChannel", { baseWhere: { channelId: "c1" }, row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("restrictsCounts throws COUNT_RLS_UNSUPPORTED — same seam as count/aggregate", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { restrictsCounts: true, row: "m1" })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
            name: "CirrusError",
        });
    });

    test("lazy backfill rebuilds the companion when rows pre-existed the index", async () => {
        // Set up the schema with NO rank index, insert rows, then swap in the
        // schema that declares one and ensure the first rank() backfills.
        const baseSchema: SchemaLike = makeSchema();
        const writer = setupWriter(baseSchema);

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        const schemaWithRank = makeSchema(byChannelByCreation);

        runShardMigrations(harness.sql, schemaWithRank);

        const writer2 = createShardCtxDb({ clock: () => 1_700_000_000_000, schema: schemaWithRank, sql: harness.sql });

        await expect(writer2.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 2 });
        await expect(writer2.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 2 });
    });

    test("explicit backfillRankIndexes is idempotent and populates empty companions", async () => {
        const writer = setupWriter(makeSchema());

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        const schemaWithRank = makeSchema(byChannelByCreation);

        runShardMigrations(harness.sql, schemaWithRank);
        backfillRankIndexes(harness.sql, schemaWithRank);
        backfillRankIndexes(harness.sql, schemaWithRank); // idempotent

        const writer2 = createShardCtxDb({ clock: () => 1_700_000_000_000, schema: schemaWithRank, sql: harness.sql });

        await expect(writer2.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("rankPage walks the companion in declared sort order", async () => {
        const writer = setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

        const page = await writer.rankPage("messages", "leaderboard", { take: 10 });

        expect(page.page.map((doc) => doc["_id"])).toEqual(["m2", "m3", "m1"]);
        expect(page.isDone).toBe(true);
        expect(page.continueCursor).toBeNull();
    });

    test("rankPage paginates with cursor + take", async () => {
        const writer = setupWriter(makeSchema(byScoreDesc));

        for (let i = 0; i < 5; i += 1) {
            await writer.insert("messages", { _id: `m${i}`, archived: false, channelId: "c1", score: i * 10 }, { allowExplicitId: true });
        }

        const first = await writer.rankPage("messages", "leaderboard", { take: 2 });

        expect(first.page.map((doc) => doc["_id"])).toEqual(["m4", "m3"]);
        expect(first.isDone).toBe(false);
        expect(first.continueCursor).not.toBeNull();

        const second = await writer.rankPage("messages", "leaderboard", { cursor: first.continueCursor, take: 2 });

        expect(second.page.map((doc) => doc["_id"])).toEqual(["m2", "m1"]);
        expect(second.isDone).toBe(false);
    });

    test("rankPage scoped by partition `where`", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        const page = await writer.rankPage("messages", "byChannel", { take: 10, where: { channelId: "c1" } });

        expect(page.page.map((doc) => doc["_id"])).toEqual(["m1", "m3"]);
    });

    test("unknown rankIndex name throws", async () => {
        const writer = setupWriter(makeSchema(byChannelByCreation));

        await expect(writer.rank("messages", "nope", { row: "anything" })).rejects.toThrow(/unknown rankIndex/);
        await expect(writer.rankPage("messages", "nope")).rejects.toThrow(/unknown rankIndex/);
    });
});
