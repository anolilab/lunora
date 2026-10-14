import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * The same surface as `ctx-db.test.ts`, but driven through a real SQLite
 * engine (`node:sqlite`) instead of the SQL-string-matching fake. This is the
 * suite that catches divergence between what we *think* the emitted SQL does
 * and what SQLite actually does — `json_extract` ordering, type affinity on
 * the JSON-blob columns, and UNIQUE-index enforcement.
 */

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (
    overrides: { broadcast?: BroadcastDelta; clock?: () => number; idGenerator?: () => string } = {},
): { deltas: Parameters<BroadcastDelta>[0][]; writer: DatabaseWriterLike } => {
    runShardMigrations(harness.sql, messagesSchema);

    const deltas: Parameters<BroadcastDelta>[0][] = [];
    const writer = createShardContextDatabase({
        broadcast: overrides.broadcast ?? ((delta) => deltas.push(delta)),
        clock: overrides.clock ?? (() => 1_700_000_000_000),
        idGenerator: overrides.idGenerator,
        schema: messagesSchema,
        sql: harness.sql,
    });

    return { deltas, writer };
};

describe("ctx-db against real SQLite", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("ctx-db against real SQLite — migrations", () => {
        it("creates queryable tables for every non-global schema table", async () => {
            expect.assertions(2);

            const { writer } = setupWriter({ idGenerator: () => "m_1" });

            await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
            await writer.insert("roomMembers", { _id: "rm_1", roomId: "r1", userId: "u1" }, { allowExplicitId: true });

            await expect(writer.query("messages").collect()).resolves.toHaveLength(1);
            await expect(writer.query("roomMembers").collect()).resolves.toHaveLength(1);
        });

        it("does not create a table for .global() tables", () => {
            expect.assertions(1);

            setupWriter();

            // `profiles` is flagged `.global()`, so no SQLite table is created and
            // SELECTing it must fail at the engine, not silently return rows.
            expect(() => harness.raw('SELECT * FROM "profiles"')).toThrow(/no such table/u);
        });

        it("enforces UNIQUE indexes at the engine level", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "dup" }, { allowExplicitId: true });

            // `by_text` is declared unique — a second row with the same text must
            // be rejected by SQLite, not just by the adapter.
            await expect(writer.insert("messages", { _id: "b", authorId: "u2", channelId: "c2", text: "dup" }, { allowExplicitId: true })).rejects.toThrow(
                /unique constraint violation/u,
            );
        });
    });

    describe("ctx-db against real SQLite — row-size overflow", () => {
        /**
         * `SQLITE_LIMIT_LENGTH` is ~1 GB on a stock `node:sqlite` build and is not
         * settable from JS, so a real oversized row is not reproducible in a unit
         * test. The recogniser is what is under test, so the engine is wrapped to
         * raise SQLite's own wording on the INSERT and nothing else.
         */
        const failingWrites = (): SqlExec => {
            return {
                exec: ((query: string, ...params: unknown[]) => {
                    if (/^\s*INSERT\s+INTO\s+"messages"/iu.test(query)) {
                        throw new Error("Error: string or blob too big");
                    }

                    return (harness.sql.exec as (this: SqlExec, q: string, ...rest: unknown[]) => unknown).call(harness.sql, query, ...params);
                }) as SqlExec["exec"],
            };
        };

        it("names the row-size limit instead of letting SQLITE_TOOBIG redact to INTERNAL", async () => {
            expect.assertions(3);

            runShardMigrations(harness.sql, messagesSchema);

            const writer = createShardContextDatabase({
                broadcast: () => {},
                clock: () => 1_700_000_000_000,
                schema: messagesSchema,
                sql: failingWrites(),
            });

            const error = await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "big" }).catch((error_: unknown) => error_);

            // A plain `Error` here is what `toErrorBody` redacts to
            // `{ code: "INTERNAL", message: "Internal error" }`, status 500.
            expect(error).toBeInstanceOf(LunoraError);
            expect((error as LunoraError).code).toBe("PAYLOAD_TOO_LARGE");
            expect((error as LunoraError).message).toMatch(/too large to store in "messages".*per-row ceiling/su);
        });
    });

    describe("ctx-db against real SQLite — round-trips", () => {
        it("preserves boolean, null, number, and array types through JSON", async () => {
            expect.assertions(1);

            const { writer } = setupWriter({ idGenerator: () => "m_1" });

            await writer.insert("messages", {
                authorId: "u1",
                channelId: "c1",
                deletedAt: null,
                pinned: true,
                score: 3.5,
                tags: ["x", "y"],
                text: "typed",
            });

            const fetched = await writer.get("m_1");

            expect(fetched).toMatchObject({
                deletedAt: null,
                pinned: true,
                score: 3.5,
                tags: ["x", "y"],
            });
        });

        it("get() returns null for an unknown id", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await expect(writer.get("nope")).resolves.toBeNull();
        });

        it("patch merges, replace overwrites, delete removes — verified by re-read", async () => {
            expect.assertions(3);

            const { writer } = setupWriter({ idGenerator: () => "m_1" });

            await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });

            await writer.patch("m_1", { text: "edited" });

            await expect(writer.get("m_1")).resolves.toMatchObject({ channelId: "c1", text: "edited" });

            await writer.replace("m_1", { authorId: "u2", channelId: "c2", text: "fresh" });

            await expect(writer.get("m_1")).resolves.toMatchObject({ _id: "m_1", authorId: "u2", channelId: "c2", text: "fresh" });

            await writer.delete("m_1");

            await expect(writer.get("m_1")).resolves.toBeNull();
        });
    });

    describe("ctx-db against real SQLite — queries", () => {
        it("collect() orders by _creationTime ascending", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });

            const rows = await writer.query("messages").collect();

            // Insertion order is b, a and creation time is b<a, so order stays b,a.
            expect(rows.map((row) => row["_id"])).toEqual(["b", "a"]);
        });

        it("withIndex().eq() filters in the engine", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "x" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c2", text: "y" }, { allowExplicitId: true });

            const rows = await writer
                .query("messages")
                .withIndex("by_channel", (q) => q.eq("channelId", "c2"))
                .collect();

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ _id: "b" });
        });

        it("withIndex() range on _creationTime uses real numeric comparison", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true }); // t=10
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true }); // t=20
            await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "3" }, { allowExplicitId: true }); // t=30

            const rows = await writer
                .query("messages")
                .withIndex("by_channel_creation", (q) => q.eq("channelId", "c1").gte("_creationTime", 20))
                .collect();

            expect(rows.map((row) => row["_id"])).toEqual(["b", "c"]);
        });

        it("take(n) limits at the engine when there is no in-memory filter", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "3" }, { allowExplicitId: true });

            const rows = await writer.query("messages").take(2);

            expect(rows.map((row) => row["_id"])).toEqual(["a", "b"]);
        });

        it("filter() applies in JS after the engine fetch", async () => {
            expect.assertions(2);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "keep" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "drop" }, { allowExplicitId: true });

            const rows = await writer
                .query("messages")
                .filter((document) => document["text"] === "keep")
                .collect();

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ _id: "a" });
        });

        it("first() returns the earliest row or null", async () => {
            expect.assertions(2);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await expect(writer.query("messages").first()).resolves.toBeNull();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "1" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "2" }, { allowExplicitId: true });

            await expect(writer.query("messages").first()).resolves.toMatchObject({ _id: "a" });
        });
    });

    describe("ctx-db against real SQLite — .order()", () => {
        const seed = async (writer: DatabaseWriterLike): Promise<void> => {
            // Insert out of creation order so the ORDER BY is doing real work.
            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "third" }, { allowExplicitId: true });
        };

        it("defaults to ascending creation order", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await seed(writer);

            const rows = await writer.query("messages").collect();

            expect(rows.map((row) => row["_id"])).toStrictEqual(["a", "b", "c"]);
        });

        it("order('desc') reverses creation order", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await seed(writer);

            const rows = await writer.query("messages").order("desc").collect();

            expect(rows.map((row) => row["_id"])).toStrictEqual(["c", "b", "a"]);
        });

        it("order('desc') composes with first() and take()", async () => {
            expect.assertions(2);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await seed(writer);

            await expect(writer.query("messages").order("desc").first()).resolves.toMatchObject({ _id: "c" });
            await expect(writer.query("messages").order("desc").take(2)).resolves.toMatchObject([{ _id: "c" }, { _id: "b" }]);
        });

        it("order('desc') composes with withIndex() and filter()", async () => {
            expect.assertions(1);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "keep1" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c2", text: "other" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "keep2" }, { allowExplicitId: true });

            const rows = await writer
                .query("messages")
                .withIndex("by_channel_creation", (q) => q.eq("channelId", "c1"))
                .filter((document) => String(document["text"]).startsWith("keep"))
                .order("desc")
                .collect();

            expect(rows.map((row) => row["_id"])).toStrictEqual(["c", "a"]);
        });

        it("order('desc') composes with paginate()", async () => {
            expect.assertions(2);

            let now = 0;
            const { writer } = setupWriter({
                clock: () => {
                    now += 10;

                    return now;
                },
            });

            await seed(writer);

            const firstPage = await writer.query("messages").order("desc").paginate({ cursor: null, numItems: 2 });

            expect(firstPage.page.map((row) => row["_id"])).toStrictEqual(["c", "b"]);

            const secondPage = await writer.query("messages").order("desc").paginate({ cursor: firstPage.continueCursor, numItems: 2 });

            expect(secondPage.page.map((row) => row["_id"])).toStrictEqual(["a"]);
        });
    });

    describe("ctx-db against real SQLite — .unique()", () => {
        it("returns null when nothing matches", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await expect(
                writer
                    .query("messages")
                    .withIndex("by_channel", (q) => q.eq("channelId", "absent"))
                    .unique(),
            ).resolves.toBeNull();
        });

        it("returns the single matching document", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "solo", text: "only" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "other", text: "x" }, { allowExplicitId: true });

            await expect(
                writer
                    .query("messages")
                    .withIndex("by_channel", (q) => q.eq("channelId", "solo"))
                    .unique(),
            ).resolves.toMatchObject({ _id: "a" });
        });

        it("throws when more than one document matches", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "dup", text: "x" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "dup", text: "y" }, { allowExplicitId: true });

            await expect(
                writer
                    .query("messages")
                    .withIndex("by_channel", (q) => q.eq("channelId", "dup"))
                    .unique(),
            ).rejects.toThrow(/matched 2 documents/u);
        });

        it("applies .filter() before deciding uniqueness", async () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "dup", text: "keep" }, { allowExplicitId: true });
            await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "dup", text: "drop" }, { allowExplicitId: true });

            await expect(
                writer
                    .query("messages")
                    .withIndex("by_channel", (q) => q.eq("channelId", "dup"))
                    .filter((document) => document["text"] === "keep")
                    .unique(),
            ).resolves.toMatchObject({ _id: "a" });
        });
    });

    describe("ctx-db against real SQLite — normalizeId", () => {
        it("returns the id for a structurally valid string", () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            expect(writer.normalizeId("messages", "m_123")).toBe("m_123");
        });

        it("returns null for empty or whitespace-bearing ids", () => {
            expect.assertions(3);

            const { writer } = setupWriter();

            expect(writer.normalizeId("messages", "")).toBeNull();
            expect(writer.normalizeId("messages", "has space")).toBeNull();
            expect(writer.normalizeId("messages", " padded ")).toBeNull();
        });

        it("does not read the database (a valid id for an absent row still normalizes)", () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            // No row with this id exists, yet a structurally valid id round-trips.
            expect(writer.normalizeId("messages", "never-inserted")).toBe("never-inserted");
        });

        it("throws on an unknown table", () => {
            expect.assertions(1);

            const { writer } = setupWriter();

            expect(() => writer.normalizeId("nope", "x")).toThrow(/unknown table/u);
        });
    });
});
