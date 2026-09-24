import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { backfillRankIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { rankKeyFromDoc } from "../src/rank";
import type { RankIndexDefinitionLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

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

const makeSchema = (...indexes: RankIndexDefinitionLike[]): SchemaLike => {
    return {
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
    };
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

describe("ctx-db rank", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("rankIndex runtime", () => {
        it("rank() returns 1-based position + partition total within partition", async () => {
            expect.assertions(4);

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

        it("rank() accepts a row document instead of an id", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 100 }, { allowExplicitId: true });

            const doc = await writer.get("m2");

            await expect(writer.rank("messages", "leaderboard", { row: doc! })).resolves.toEqual({ position: 1, total: 2 });
        });

        it("rank() returns null when the row isn't in the index", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            await expect(writer.rank("messages", "byChannel", { row: "does-not-exist" })).resolves.toBeNull();
        });

        it("desc sort puts the highest value first", async () => {
            expect.assertions(3);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

            await expect(writer.rank("messages", "leaderboard", { row: "m2" })).resolves.toEqual({ position: 1, total: 3 });
            await expect(writer.rank("messages", "leaderboard", { row: "m3" })).resolves.toEqual({ position: 2, total: 3 });
            await expect(writer.rank("messages", "leaderboard", { row: "m1" })).resolves.toEqual({ position: 3, total: 3 });
        });

        it("insert / update / delete maintains the rank companion atomically", async () => {
            expect.assertions(5);

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

        it("static `where` filters rows out of the index", async () => {
            expect.assertions(5);

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

        it("rank() returns null when the requested partition doesn't match the row's stored partition", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            // m1 lives in c1; asking for it in c2 returns null (the index doesn't
            // cross partition boundaries).
            await expect(writer.rank("messages", "byChannel", { row: "m1", where: { channelId: "c2" } })).resolves.toBeNull();
        });

        it("baseWhere participates identically to aggregates", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            // baseWhere scopes the partition the same way `where` does.
            await expect(writer.rank("messages", "byChannel", { baseWhere: { channelId: "c1" }, row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
        });

        it("restrictsCounts throws COUNT_RLS_UNSUPPORTED — same seam as count/aggregate", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            await expect(writer.rank("messages", "byChannel", { restrictsCounts: true, row: "m1" })).rejects.toMatchObject({
                code: "COUNT_RLS_UNSUPPORTED",
                name: "LunoraError",
            });
        });

        it("lazy backfill rebuilds the companion when rows pre-existed the index", async () => {
            expect.assertions(2);

            // Set up the schema with NO rank index, insert rows, then swap in the
            // schema that declares one and ensure the first rank() backfills.
            const baseSchema: SchemaLike = makeSchema();
            const writer = setupWriter(baseSchema);

            await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            const schemaWithRank = makeSchema(byChannelByCreation);

            runShardMigrations(harness.sql, schemaWithRank);

            const writer2 = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithRank, sql: harness.sql });

            await expect(writer2.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 2 });
            await expect(writer2.rank("messages", "byChannel", { row: "m2" })).resolves.toEqual({ position: 2, total: 2 });
        });

        it("explicit backfillRankIndexes is idempotent and populates empty companions", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            const schemaWithRank = makeSchema(byChannelByCreation);

            runShardMigrations(harness.sql, schemaWithRank);
            backfillRankIndexes(harness.sql, schemaWithRank);
            backfillRankIndexes(harness.sql, schemaWithRank); // idempotent

            const writer2 = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: schemaWithRank, sql: harness.sql });

            await expect(writer2.rank("messages", "byChannel", { row: "m1" })).resolves.toEqual({ position: 1, total: 1 });
        });

        it("rankPage walks the companion in declared sort order", async () => {
            expect.assertions(3);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

            const page = await writer.rankPage("messages", "leaderboard", { take: 10 });

            expect(page.page.map((document_) => document_["_id"])).toEqual(["m2", "m3", "m1"]);
            expect(page.isDone).toBe(true);
            expect(page.continueCursor).toBeNull();
        });

        it("rankPage paginates with cursor + take", async () => {
            expect.assertions(5);

            const writer = setupWriter(makeSchema(byScoreDesc));

            for (let i = 0; i < 5; i += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ordered inserts into the same DB
                await writer.insert("messages", { _id: `m${String(i)}`, archived: false, channelId: "c1", score: i * 10 }, { allowExplicitId: true });
            }

            const first = await writer.rankPage("messages", "leaderboard", { take: 2 });

            expect(first.page.map((document_) => document_["_id"])).toEqual(["m4", "m3"]);
            expect(first.isDone).toBe(false);
            expect(first.continueCursor).not.toBeNull();

            const second = await writer.rankPage("messages", "leaderboard", { cursor: first.continueCursor, take: 2 });

            expect(second.page.map((document_) => document_["_id"])).toEqual(["m2", "m1"]);
            expect(second.isDone).toBe(false);
        });

        // A rank sort column genuinely holds NULL: `syncRankIndexEntry` writes
        // `record[field] ?? null`. A bare `<`/`>` at the seek pivot is UNKNOWN
        // against one, so the page that first reaches the NULL group came back
        // empty (with `isDone: false` on the page before it) and `rank()`
        // reported a confident position against a correct total.
        describe("a nullable sort column", () => {
            // 5 scored rows and 7 unscored, paged 4 at a time: the NULL group
            // spans two page boundaries, so a seek that cannot resume from
            // inside it loses rows a smaller fixture would never miss.
            const seedWithNulls = async (writer: DatabaseWriterLike): Promise<void> => {
                for (let index = 0; index < 5; index += 1) {
                    // eslint-disable-next-line no-await-in-loop -- sequential ordered inserts into the same DB
                    await writer.insert(
                        "messages",
                        { _id: `s${String(index)}`, archived: false, channelId: "c1", score: index * 10 },
                        { allowExplicitId: true },
                    );
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

                const writer = setupWriter(makeSchema(byScoreDesc));

                await seedWithNulls(writer);

                const ids = await drain(writer, "leaderboard");

                // NULLs sort LAST descending: the scored rows high-to-low, then
                // every unscored row, each exactly once.
                expect(ids).toStrictEqual(["s4", "s3", "s2", "s1", "s0", "n0", "n1", "n2", "n3", "n4", "n5", "n6"]);
                expect(new Set(ids).size).toBe(12);
            });

            it("pages through the NULL group ascending without losing a row", async () => {
                expect.assertions(2);

                const writer = setupWriter(makeSchema({ name: "byScore", on: "messages", sortBy: [{ direction: "asc", field: "score" }] }));

                await seedWithNulls(writer);

                const ids = await drain(writer, "byScore");

                // NULLs sort FIRST ascending.
                expect(ids).toStrictEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "s0", "s1", "s2", "s3", "s4"]);
                expect(new Set(ids).size).toBe(12);
            });

            it("ranks a NULL-valued row where the ordering actually puts it", async () => {
                expect.assertions(3);

                const writer = setupWriter(makeSchema(byScoreDesc));

                await seedWithNulls(writer);

                // Descending: 5 scored rows first, then the NULL group ordered
                // by the `__id__` tiebreak.
                await expect(writer.rank("messages", "leaderboard", { row: "s4" })).resolves.toStrictEqual({ position: 1, total: 12 });
                await expect(writer.rank("messages", "leaderboard", { row: "n0" })).resolves.toStrictEqual({ position: 6, total: 12 });
                await expect(writer.rank("messages", "leaderboard", { row: "n6" })).resolves.toStrictEqual({ position: 12, total: 12 });
            });
        });

        it("rankPage scoped by partition `where`", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            const page = await writer.rankPage("messages", "byChannel", { take: 10, where: { channelId: "c1" } });

            expect(page.page.map((document_) => document_["_id"])).toEqual(["m1", "m3"]);
        });

        it("rankPageRows returns keyed rows + hasMore, byte-compatible with the coordinator key", async () => {
            expect.assertions(4);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

            // rankPageRows is the optional cross-shard surface; the DO writer always defines it.
            const result = await writer.rankPageRows?.("messages", "leaderboard", { take: 2 });

            // Descending score: m2 (50) then m3 (30), with a third row remaining.
            expect(result?.rows.map((row) => row.doc["_id"])).toEqual(["m2", "m3"]);
            expect(result?.hasMore).toBe(true);
            // Each row's key matches rankKeyFromDoc — what the coordinator's comparator expects.
            expect(result?.rows[0]?.key).toEqual({ partitionKey: "", rowId: "m2", sortValues: [50] });
            expect(result?.rows[1]?.key).toEqual({ partitionKey: "", rowId: "m3", sortValues: [30] });
        });

        it("rankPageRows resumes strictly-after the `after` key", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byScoreDesc));

            for (let i = 0; i < 5; i += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential ordered inserts into the same DB
                await writer.insert("messages", { _id: `m${String(i)}`, archived: false, channelId: "c1", score: i * 10 }, { allowExplicitId: true });
            }

            const first = await writer.rankPageRows?.("messages", "leaderboard", { take: 2 });

            expect(first?.rows.map((row) => row.doc["_id"])).toEqual(["m4", "m3"]);

            // Resume from the last row's key — same structured key the coordinator forwards.
            const lastKey = first?.rows.at(-1)?.key;
            const second = await writer.rankPageRows?.("messages", "leaderboard", { after: lastKey, take: 2 });

            expect(second?.rows.map((row) => row.doc["_id"])).toEqual(["m2", "m1"]);
        });

        it("rankPageRows scopes to an explicit pre-encoded partitionKey", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await writer.insert("messages", { _creationTime: 100, _id: "m1", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 200, _id: "m2", archived: false, channelId: "c2", score: 0 }, { allowExplicitId: true });
            await writer.insert("messages", { _creationTime: 300, _id: "m3", archived: false, channelId: "c1", score: 0 }, { allowExplicitId: true });

            // Pre-encoded partition tuple, exactly as the coordinator forwards it.
            const partitionKey = JSON.stringify({ channelId: "c1" });
            const result = await writer.rankPageRows?.("messages", "byChannel", { partitionKey, take: 10 });

            expect(result?.rows.map((row) => row.doc["_id"])).toEqual(["m1", "m3"]);
        });

        it("unknown rankIndex name throws", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byChannelByCreation));

            await expect(writer.rank("messages", "nope", { row: "anything" })).rejects.toThrow(/unknown rankIndex/);
            await expect(writer.rankPage("messages", "nope")).rejects.toThrow(/unknown rankIndex/);
        });
    });

    describe("rankBefore + rankKeyFromDoc", () => {
        it("rankKeyFromDoc derives the partition key, raw sort values, and id from a doc", () => {
            expect.assertions(2);

            const channelDoc = { _creationTime: 200, _id: "m7", archived: false, channelId: "c1", score: 0 };

            expect(rankKeyFromDoc(byChannelByCreation, channelDoc)).toEqual({
                partitionKey: JSON.stringify({ channelId: "c1" }),
                rowId: "m7",
                sortValues: [200],
            });

            // partitionBy: [] → the single global partition keyed on "".
            expect(rankKeyFromDoc(byScoreDesc, channelDoc)).toEqual({ partitionKey: "", rowId: "m7", sortValues: [0] });
        });

        it("rankBefore agrees with rank() for a locally-owned row", async () => {
            expect.assertions(3);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m2", archived: false, channelId: "c1", score: 50 }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "m3", archived: false, channelId: "c1", score: 30 }, { allowExplicitId: true });

            // For an owned row, rankBefore(key) === { before: position - 1, total }.
            for (const id of ["m1", "m2", "m3"]) {
                // eslint-disable-next-line no-await-in-loop -- sequential reads against one DB; assertions accumulate
                const ranked = await writer.rank("messages", "leaderboard", { row: id });
                // eslint-disable-next-line no-await-in-loop -- ditto
                const doc = await writer.get(id);
                const key = rankKeyFromDoc(byScoreDesc, doc!);

                // eslint-disable-next-line no-await-in-loop -- ditto
                await expect(writer.rankBefore!("messages", "leaderboard", key)).resolves.toEqual({
                    before: ranked!.position - 1,
                    total: ranked!.total,
                });
            }
        });

        it("rankBefore counts on a peer companion that does NOT own the row being ranked", async () => {
            expect.assertions(2);

            // A global leaderboard partition (partitionBy: []) split across two
            // shards. The "peer" writer holds a disjoint row set — the row we
            // rank lives on another shard, so a by-id lookup would miss it, but
            // rankBefore counts strictly-before the EXPLICIT key regardless.
            const peer = setupWriter(makeSchema(byScoreDesc));

            await peer.insert("messages", { _id: "p1", archived: false, channelId: "c1", score: 90 }, { allowExplicitId: true });
            await peer.insert("messages", { _id: "p2", archived: false, channelId: "c1", score: 70 }, { allowExplicitId: true });
            await peer.insert("messages", { _id: "p3", archived: false, channelId: "c1", score: 20 }, { allowExplicitId: true });

            // Rank a foreign row scored 75: desc order → p1(90) is strictly
            // before it, p2(70)/p3(20) are after. before=1, total=3 (the peer's
            // own partition rows).
            const foreign = { _id: "x1", archived: false, channelId: "c9", score: 75 };

            await expect(peer.rankBefore!("messages", "leaderboard", rankKeyFromDoc(byScoreDesc, foreign))).resolves.toEqual({ before: 1, total: 3 });

            // A foreign row that would top the board: nothing strictly before it.
            const top = { _id: "x2", archived: false, channelId: "c9", score: 999 };

            await expect(peer.rankBefore!("messages", "leaderboard", rankKeyFromDoc(byScoreDesc, top))).resolves.toEqual({ before: 0, total: 3 });
        });

        it("rankBefore restrictsCounts throws COUNT_RLS_UNSUPPORTED — same seam as rank()", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await writer.insert("messages", { _id: "m1", archived: false, channelId: "c1", score: 10 }, { allowExplicitId: true });

            await expect(
                writer.rankBefore!("messages", "leaderboard", { partitionKey: "", restrictsCounts: true, rowId: "x1", sortValues: [5] }),
            ).rejects.toMatchObject({ code: "COUNT_RLS_UNSUPPORTED", name: "LunoraError" });
        });

        it("rankBefore throws on an unknown rankIndex name", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byScoreDesc));

            await expect(writer.rankBefore!("messages", "nope", { partitionKey: "", rowId: "x", sortValues: [] })).rejects.toThrow(/unknown rankIndex/);
        });
    });

    describe("cross-shard partition guard", () => {
        /** `events` is `.shardBy("userId")`; the rankIndex's partitionBy controls whether a partition stays on one shard. */
        const makeShardedSchema = (partitionBy: string[]): SchemaLike => {
            return {
                tables: {
                    events: {
                        indexes: [],
                        rankIndexes: [{ name: "byScore", on: "events", partitionBy, sortBy: [{ direction: "desc", field: "score" }] }],
                        shape: { score: { kind: "number" }, userId: { kind: "string" } },
                        shardMode: { field: "userId", kind: "shardBy" },
                    },
                },
            };
        };

        it("rank() refuses when the partition spans shards (shard key not in partitionBy)", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeShardedSchema([]));

            await writer.insert("events", { _id: "e1", score: 10, userId: "u1" }, { allowExplicitId: true });

            await expect(writer.rank("events", "byScore", { row: "e1" })).rejects.toMatchObject({ code: "CROSS_SHARD_RANK_UNSUPPORTED", name: "LunoraError" });
        });

        it("rankPage() refuses when the partition spans shards", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeShardedSchema([]));

            await expect(writer.rankPage("events", "byScore")).rejects.toMatchObject({ code: "CROSS_SHARD_RANK_UNSUPPORTED", name: "LunoraError" });
        });

        it("allows rank() when partitionBy includes the shard key (partition stays on one shard)", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeShardedSchema(["userId"]));

            await writer.insert("events", { _id: "e1", score: 10, userId: "u1" }, { allowExplicitId: true });

            await expect(writer.rank("events", "byScore", { row: "e1", where: { userId: "u1" } })).resolves.toMatchObject({ position: 1 });
        });
    });
});
