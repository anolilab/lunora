import type { DatabaseWriterLike, RankIndexDefinitionLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase, runD1RankMigrations } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Mirror of `@lunora/do`'s ctx-db.rank suite against the D1 column dialect.
 * Covers trigger-maintained sorted companions, partition semantics, RLS
 * coupling seam, and the opt-in migration helper.
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

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

const makeSchema = (...indexes: RankIndexDefinitionLike[]): SchemaLike => {
    return {
        tables: {
            messages: {
                indexes: [],
                rankIndexes: indexes,
                shape: {
                    archived: col("boolean"),
                    channelId: col("string"),
                    // Nullable: an unscored row is what puts a NULL in the rank
                    // companion's sort column.
                    score: { _meta: { column: { notNull: false } }, kind: "number" },
                },
            },
        },
    };
};

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    harness.ddl(
        `CREATE TABLE "messages" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "archived" INTEGER,
            "channelId" TEXT,
            "score" INTEGER
        )`,
    );

    await runD1RankMigrations(harness.exec, schema);

    return createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });
};

describe("d1 rankIndex parity", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("rank() returns 1-based position + partition total", async () => {
        expect.assertions(3);

        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 150, _id: "m3", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 2 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 2 });
        await expect(writer.rank("messages", "byChannel", { row: "m3" })).resolves.toEqual({ position: 1, total: 1 });
    });

    it("update / delete keeps the companion in step", async () => {
        expect.assertions(3);

        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await writer.patch("m2", { channelId: "c2" });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
        await expect(writer.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 1, total: 1 });

        await writer.delete("m1");

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toBeNull();
    });

    it("desc sort returns the highest first", async () => {
        expect.assertions(3);

        const writer = await setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "leaderboard", { row: "m2" })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m3" })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("messages", "leaderboard", { row: "m1" })).resolves.toEqual({ position: 3, total: 3 });
    });

    it("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { restrictsCounts: true, row: "m1" })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
        });
    });

    it("rankPage walks the companion in declared sort order", async () => {
        expect.assertions(2);

        const writer = await setupWriter(makeSchema(byScoreDesc));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

        const page = await writer.rankPage("messages", "leaderboard", { take: 10 });

        expect(page.page.map((document_) => document_["_id"])).toEqual(["m2", "m3", "m1"]);
        expect(page.isDone).toBe(true);
    });

    // The D1 twin of `@lunora/shard-engine`'s nullable-sort-column suite. A rank
    // sort column genuinely holds NULL (`serializeColumnValue(row[field] ?? null)`),
    // and `col < NULL` / `col > NULL` are UNKNOWN, so a bare comparator at the
    // seek pivot dropped every row from the page that first reached the NULL
    // group and made `rank()` answer against a partial count.
    describe("a nullable sort column", () => {
        // 5 scored rows and 7 unscored, paged 4 at a time: the NULL group spans
        // two page boundaries, so a seek that cannot resume from inside it loses
        // rows a smaller fixture would never miss.
        const seedWithNulls = async (writer: DatabaseWriterLike): Promise<void> => {
            for (let index = 0; index < 5; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ordered inserts into the same DB
                await writer.insert("messages", { _id: `s${String(index)}`, archived: false, channelId: "c1", score: index * 10 }, { allowExplicitId: true });
            }

            for (let index = 0; index < 7; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ordered inserts into the same DB
                await writer.insert(
                    "messages",
                    // An unscored row IS a NULL sort column — the case under test.
                    { _id: `n${String(index)}`, archived: false, channelId: "c1", score: null },
                    { allowExplicitId: true },
                );
            }
        };

        const drain = async (writer: DatabaseWriterLike, index: string): Promise<string[]> => {
            const ids: string[] = [];
            let cursor: null | string | undefined;

            for (let page = 0; page < 10; page += 1) {
                // eslint-disable-next-line no-await-in-loop -- pagination is inherently sequential
                const result = await writer.rankPage("messages", index, { cursor, take: 4 });

                ids.push(...result.page.map((document_) => document_["_id"] as string));

                if (result.isDone) {
                    return ids;
                }

                cursor = result.continueCursor;
            }

            throw new Error("rankPage never reported isDone");
        };

        it("pages through the NULL group descending without losing a row", async () => {
            expect.assertions(2);

            const writer = await setupWriter(makeSchema(byScoreDesc));

            await seedWithNulls(writer);

            const ids = await drain(writer, "leaderboard");

            expect(ids).toStrictEqual(["s4", "s3", "s2", "s1", "s0", "n0", "n1", "n2", "n3", "n4", "n5", "n6"]);
            expect(new Set(ids).size).toBe(12);
        });

        it("pages through the NULL group ascending without losing a row", async () => {
            expect.assertions(2);

            const writer = await setupWriter(makeSchema({ name: "byScore", on: "messages", sortBy: [{ direction: "asc", field: "score" }] }));

            await seedWithNulls(writer);

            const ids = await drain(writer, "byScore");

            expect(ids).toStrictEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "s0", "s1", "s2", "s3", "s4"]);
            expect(new Set(ids).size).toBe(12);
        });

        it("ranks a NULL-valued row where the ordering actually puts it", async () => {
            expect.assertions(3);

            const writer = await setupWriter(makeSchema(byScoreDesc));

            await seedWithNulls(writer);

            await expect(writer.rank("messages", "leaderboard", { row: "s4" })).resolves.toStrictEqual({ position: 1, total: 12 });
            await expect(writer.rank("messages", "leaderboard", { row: "n0" })).resolves.toStrictEqual({ position: 6, total: 12 });
            await expect(writer.rank("messages", "leaderboard", { row: "n6" })).resolves.toStrictEqual({ position: 12, total: 12 });
        });
    });

    it("rankPage scoped by partition `where`", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema(byChannel));

        await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });
        await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        const page = await writer.rankPage("messages", "byChannel", { take: 10, where: { channelId: "c1" } });

        expect(page.page.map((document_) => document_["_id"])).toEqual(["m1", "m3"]);
    });

    it("lazily materializes the rank companion without an explicit migration", async () => {
        expect.assertions(1);

        // Skip runD1RankMigrations — the writer's lazy ensureMigrated() must
        // create the companion before the first insert syncs it, so rank()
        // returns a real position rather than null.
        harness.ddl(
            `CREATE TABLE "messages" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "_version" INTEGER,
                "archived" INTEGER,
                "channelId" TEXT,
                "score" INTEGER
            )`,
        );

        const schema = makeSchema(byChannel);
        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

        await expect(writer.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
    });

    it("rankPage throws on a rank index with an empty sortBy", async () => {
        expect.assertions(1);

        // The schema builder already rejects an empty `sortBy`, so this degenerate
        // index is unreachable in normal use. The d1 reader still guards it so a
        // hand-built / malformed definition fails loudly rather than paginating a
        // silently wrong/empty page (buildRankCursorSeek returning undefined).
        const emptySortBy: RankIndexDefinitionLike = {
            name: "degenerate",
            on: "messages",
            sortBy: [],
        };

        const writer = await setupWriter(makeSchema(emptySortBy));

        await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });

        await expect(writer.rankPage("messages", "degenerate", { take: 10 })).rejects.toThrow(/at least one "sortBy" column/);
    });
});
