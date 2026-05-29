import type { DatabaseWriterLike, RankIndexDefinitionLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createD1CtxDb, runD1RankMigrations } from "../src/d1-ctx-db.js";
import { createD1Exec } from "./_helpers/node-sqlite-d1.js";

/**
 * Mirror of `@cirrus/do`'s ctx-db.rank suite against the D1 column dialect.
 * Covers trigger-maintained sorted companions, partition semantics, RLS
 * coupling seam, and the opt-in migration helper.
 */

const col = (kind: string): ValidatorLike => ({ _meta: { column: { notNull: true } }, kind });

const byChannel: RankIndexDefinitionLike = {
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

const makeSchema = (...indexes: RankIndexDefinitionLike[]): SchemaLike => ({
    tables: {
        messages: {
            indexes: [],
            rankIndexes: indexes,
            shape: {
                archived: col("boolean"),
                channelId: col("string"),
                score: col("number"),
            },
        },
    },
});

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    harness.ddl(
        `CREATE TABLE "messages" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "archived" INTEGER,
            "channelId" TEXT,
            "score" INTEGER
        )`,
    );

    await runD1RankMigrations(harness.exec, schema);

    return createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });
};

beforeEach(() => {
    harness = createD1Exec();
});

afterEach(() => {
    harness.close();
});

describe("d1 rankIndex parity", () => {
    test("rank() returns 1-based position + partition total", async () => {
        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 });
        await writer.insert("messages", { _creationTime: 150, _id: "m3", archived: false, channelId: "c2", score: 0 });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 2 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 2 });
        await expect(writer.rank("messages", "byChannel", { row: "m3" })).resolves.toEqual({ position: 1, total: 1 });
    });

    test("update / delete keeps the companion in step", async () => {
        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 });

        await writer.patch("m2", { channelId: "c2" });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 1, total: 1 });

        await writer.delete("m1");

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toBeNull();
    });

    test("desc sort returns the highest first", async () => {
        const writer = await setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 });

        await expect(writer.rank("messages", "leaderboard", { row: "m2" })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m3" })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m1" })).resolves.toEqual({ position: 3, total: 3 });
    });

    test("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 });

        await expect(writer.rank("messages", "byChannel", { restrictsCounts: true, row: "m1" })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
        });
    });

    test("rankPage walks the companion in declared sort order", async () => {
        const writer = await setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 });

        const page = await writer.rankPage("messages", "leaderboard", { take: 10 });

        expect(page.page.map((doc) => doc["_id"])).toEqual(["m2", "m3", "m1"]);
        expect(page.isDone).toBe(true);
    });

    test("rankPage scoped by partition `where`", async () => {
        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c2", score: 0 });
        await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 });

        const page = await writer.rankPage("messages", "byChannel", { take: 10, where: { channelId: "c1" } });

        expect(page.page.map((doc) => doc["_id"])).toEqual(["m1", "m3"]);
    });

    test("falls back to null when no rank companion exists (opt-in)", async () => {
        // Skip runD1RankMigrations — the companion isn't materialized.
        harness.ddl(
            `CREATE TABLE "messages" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "archived" INTEGER,
                "channelId" TEXT,
                "score" INTEGER
            )`,
        );

        const schema = makeSchema(byChannel);
        const writer = createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toBeNull();
    });
});
