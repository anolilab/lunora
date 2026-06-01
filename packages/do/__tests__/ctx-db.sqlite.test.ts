import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { messagesSchema } from "./_helpers/fake-sql.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

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
    const writer = createShardCtxDb({
        sql: harness.sql,
        schema: messagesSchema,
        broadcast: overrides.broadcast ?? ((delta) => deltas.push(delta)),
        clock: overrides.clock ?? (() => 1_700_000_000_000),
        idGenerator: overrides.idGenerator,
    });

    return { writer, deltas };
};

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("ctx-db against real SQLite — migrations", () => {
    test("creates queryable tables for every non-global schema table", async () => {
        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        await writer.insert("roomMembers", { _id: "rm_1", roomId: "r1", userId: "u1" }, { allowExplicitId: true });

        await expect(writer.query("messages").collect()).resolves.toHaveLength(1);
        await expect(writer.query("roomMembers").collect()).resolves.toHaveLength(1);
    });

    test("does not create a table for .global() tables", () => {
        setupWriter();

        // `profiles` is flagged `.global()`, so no SQLite table is created and
        // SELECTing it must fail at the engine, not silently return rows.
        expect(() => harness.raw('SELECT * FROM "profiles"')).toThrow();
    });

    test("enforces UNIQUE indexes at the engine level", async () => {
        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "dup", authorId: "u1" }, { allowExplicitId: true });

        // `by_text` is declared unique — a second row with the same text must
        // be rejected by SQLite, not just by the adapter.
        await expect(writer.insert("messages", { _id: "b", channelId: "c2", text: "dup", authorId: "u2" }, { allowExplicitId: true })).rejects.toThrow();
    });
});

describe("ctx-db against real SQLite — round-trips", () => {
    test("preserves boolean, null, number, and array types through JSON", async () => {
        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", {
            channelId: "c1",
            text: "typed",
            authorId: "u1",
            pinned: true,
            deletedAt: null,
            score: 3.5,
            tags: ["x", "y"],
        });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({
            pinned: true,
            deletedAt: null,
            score: 3.5,
            tags: ["x", "y"],
        });
    });

    test("get() returns null for an unknown id", async () => {
        const { writer } = setupWriter();

        await expect(writer.get("nope")).resolves.toBeNull();
    });

    test("patch merges, replace overwrites, delete removes — verified by re-read", async () => {
        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });

        await writer.patch("m_1", { text: "edited" });

        await expect(writer.get("m_1")).resolves.toMatchObject({ text: "edited", channelId: "c1" });

        await writer.replace("m_1", { channelId: "c2", text: "fresh", authorId: "u2" });

        await expect(writer.get("m_1")).resolves.toMatchObject({ _id: "m_1", channelId: "c2", text: "fresh", authorId: "u2" });

        await writer.delete("m_1");

        await expect(writer.get("m_1")).resolves.toBeNull();
    });
});

describe("ctx-db against real SQLite — queries", () => {
    test("collect() orders by _creationTime ascending", async () => {
        let now = 0;
        const { writer } = setupWriter({
            clock: () => {
                now += 10;

                return now;
            },
        });

        await writer.insert("messages", { _id: "b", channelId: "c1", text: "second", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "a", channelId: "c1", text: "first", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer.query("messages").collect();

        // Insertion order is b, a and creation time is b<a, so order stays b,a.
        expect(rows.map((row) => row["_id"])).toEqual(["b", "a"]);
    });

    test("withIndex().eq() filters in the engine", async () => {
        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "x", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c2", text: "y", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", "c2"))
            .collect();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ _id: "b" });
    });

    test("withIndex() range on _creationTime uses real numeric comparison", async () => {
        let now = 0;
        const { writer } = setupWriter({
            clock: () => {
                now += 10;

                return now;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "1", authorId: "u1" }, { allowExplicitId: true }); // t=10
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "2", authorId: "u1" }, { allowExplicitId: true }); // t=20
        await writer.insert("messages", { _id: "c", channelId: "c1", text: "3", authorId: "u1" }, { allowExplicitId: true }); // t=30

        const rows = await writer
            .query("messages")
            .withIndex("by_channel_creation", (q) => q.eq("channelId", "c1").gte("_creationTime", 20))
            .collect();

        expect(rows.map((row) => row["_id"])).toEqual(["b", "c"]);
    });

    test("take(n) limits at the engine when there is no in-memory filter", async () => {
        let now = 0;
        const { writer } = setupWriter({
            clock: () => {
                now += 10;

                return now;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "1", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "2", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", channelId: "c1", text: "3", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer.query("messages").take(2);

        expect(rows.map((row) => row["_id"])).toEqual(["a", "b"]);
    });

    test("filter() applies in JS after the engine fetch", async () => {
        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "keep", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "drop", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .filter((document) => document["text"] === "keep")
            .collect();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ _id: "a" });
    });

    test("first() returns the earliest row or null", async () => {
        let now = 0;
        const { writer } = setupWriter({
            clock: () => {
                now += 10;

                return now;
            },
        });

        await expect(writer.query("messages").first()).resolves.toBeNull();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "1", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "2", authorId: "u1" }, { allowExplicitId: true });

        await expect(writer.query("messages").first()).resolves.toMatchObject({ _id: "a" });
    });
});
