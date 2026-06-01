import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, WriteHook } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createFakeSql, messagesSchema } from "./_helpers/fake-sql.js";

const fixedTime = 1_700_000_000_000;

const setupWriter = (
    overrides: {
        broadcast?: BroadcastDelta;
        clock?: () => number;
        idGenerator?: () => string;
        onWrite?: WriteHook;
    } = {},
): {
    deltas: Parameters<BroadcastDelta>[0][];
    sql: ReturnType<typeof createFakeSql>["sql"];
    state: ReturnType<typeof createFakeSql>["state"];
    writer: DatabaseWriterLike;
} => {
    const { sql, state } = createFakeSql();
    const deltas: Parameters<BroadcastDelta>[0][] = [];

    runShardMigrations(sql, messagesSchema);

    const writer = createShardCtxDb({
        sql,
        schema: messagesSchema,
        broadcast: overrides.broadcast ?? ((delta) => deltas.push(delta)),
        clock: overrides.clock ?? (() => fixedTime),
        idGenerator: overrides.idGenerator,
        onWrite: overrides.onWrite,
    });

    return { writer, sql, state, deltas };
};

describe("runShardMigrations", () => {
    it("creates a SQLite table per non-global schema table", () => {
        expect.assertions(2);

        const { sql, state } = createFakeSql();

        runShardMigrations(sql, messagesSchema);

        expect(state.tables.has("messages")).toBe(true);
        expect(state.tables.has("roomMembers")).toBe(true);
    });

    it("skips tables declared as .global()", () => {
        expect.assertions(1);

        const { sql, state } = createFakeSql();

        runShardMigrations(sql, messagesSchema);

        expect(state.tables.has("profiles")).toBe(false);
    });

    it("creates indexes prefixed with the table name", () => {
        expect.assertions(3);

        const { sql, state } = createFakeSql();

        runShardMigrations(sql, messagesSchema);

        expect(state.indexes.has("messages_by_channel")).toBe(true);
        expect(state.indexes.has("messages_by_channel_creation")).toBe(true);
        expect(state.indexes.has("messages_by_text")).toBe(true);
    });

    it("marks unique indexes with UNIQUE", () => {
        expect.assertions(2);

        const { sql, state } = createFakeSql();

        runShardMigrations(sql, messagesSchema);

        expect(state.indexes.get("messages_by_text")?.unique).toBe(true);
        expect(state.indexes.get("messages_by_channel")?.unique).toBe(false);
    });
});

describe("createShardCtxDb — insert/get", () => {
    let context: ReturnType<typeof setupWriter>;

    beforeEach(() => {
        context = setupWriter({ idGenerator: () => "m_1" });
    });

    it("returns the generated id when no _id is supplied", async () => {
        expect.assertions(1);

        const id = await context.writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });

        expect(id).toBe("m_1");
    });

    it("honors a caller-supplied _id", async () => {
        expect.assertions(2);

        const id = await context.writer.insert("messages", { _id: "fixed", channelId: "c1", text: "hi", authorId: "u1" }, { allowExplicitId: true });

        expect(id).toBe("fixed");

        const fetched = await context.writer.get("fixed");

        expect(fetched).toMatchObject({ _id: "fixed", text: "hi" });
    });

    it("stamps _creationTime via the injected clock", async () => {
        expect.assertions(1);

        const id = await context.writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        const fetched = await context.writer.get(id);

        expect(fetched).toMatchObject({ _creationTime: fixedTime });
    });

    it("emits a broadcast delta on insert", async () => {
        expect.assertions(2);

        await context.writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });

        expect(context.deltas).toHaveLength(1);
        expect(context.deltas[0]).toMatchObject({ table: "messages", op: "insert", key: "m_1" });
    });

    it("rejects inserts into unknown tables", async () => {
        expect.assertions(1);

        await expect(context.writer.insert("unknown", { foo: 1 })).rejects.toThrow(/unknown table/u);
    });

    it("get() returns null when no row matches", async () => {
        expect.assertions(1);

        await expect(context.writer.get("missing")).resolves.toBeNull();
    });
});

describe("createShardCtxDb — patch/replace/delete", () => {
    it("patch merges new fields into the existing document", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        await writer.patch("m_1", { text: "edited" });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ text: "edited", channelId: "c1" });
    });

    it("patch throws when the document does not exist", async () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        await expect(writer.patch("missing", { text: "x" })).rejects.toThrow(/document not found/u);
    });

    it("replace overwrites the whole document but keeps the id", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        await writer.replace("m_1", { channelId: "c2", text: "fresh", authorId: "u2" });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ _id: "m_1", channelId: "c2", text: "fresh", authorId: "u2" });
    });

    it("delete is a no-op when the id is unknown", async () => {
        expect.assertions(1);

        const { writer, deltas } = setupWriter();

        await writer.delete("missing");

        expect(deltas).toHaveLength(0);
    });

    it("delete removes the row and broadcasts a delta", async () => {
        expect.assertions(3);

        const { writer, deltas } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        deltas.length = 0;

        await writer.delete("m_1");

        await expect(writer.get("m_1")).resolves.toBeNull();
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({ table: "messages", op: "delete", key: "m_1" });
    });
});

describe("createShardCtxDb — query()", () => {
    it("collect() returns every row ordered by _creationTime", async () => {
        expect.assertions(1);

        let now = 1;
        const { writer } = setupWriter({
            clock: () => {
                const value = now;

                now += 1;

                return value;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "first", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "second", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer.query("messages").collect();

        expect(rows.map((row) => row["_id"])).toEqual(["a", "b"]);
    });

    it("take(n) limits the result size", async () => {
        expect.assertions(1);

        let now = 1;
        const { writer } = setupWriter({
            clock: () => {
                const value = now;

                now += 1;

                return value;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "first", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "second", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", channelId: "c1", text: "third", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer.query("messages").take(2);

        expect(rows.map((row) => row["_id"])).toEqual(["a", "b"]);
    });

    it("first() returns the earliest row, or null when empty", async () => {
        expect.assertions(2);

        let now = 1;
        const { writer } = setupWriter({
            clock: () => {
                const value = now;

                now += 1;

                return value;
            },
        });

        await expect(writer.query("messages").first()).resolves.toBeNull();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "first", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "second", authorId: "u1" }, { allowExplicitId: true });

        const row = await writer.query("messages").first();

        expect(row).toMatchObject({ _id: "a" });
    });

    it("filter() runs in JS against the decoded document", async () => {
        expect.assertions(2);

        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "hello", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "world", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .filter((document) => document["text"] === "world")
            .collect();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ _id: "b" });
    });

    it("withIndex().eq() pushes the predicate into SQL", async () => {
        expect.assertions(2);

        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "hi", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c2", text: "hi", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", "c2"))
            .collect();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ _id: "b" });
    });

    it("withIndex().gte() handles range filtering", async () => {
        expect.assertions(1);

        let now = 1;
        const { writer } = setupWriter({
            clock: () => {
                const value = now;

                now += 1;

                return value;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "first", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "second", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", channelId: "c1", text: "third", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .withIndex("by_channel_creation", (q) => q.eq("channelId", "c1").gte("_creationTime", 2))
            .collect();

        expect(rows.map((row) => row["_id"])).toEqual(["b", "c"]);
    });

    it("withIndex() throws on unknown indexes", () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        expect(() => writer.query("messages").withIndex("missing")).toThrow(/unknown index/u);
    });

    it("query() throws on unknown tables", () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        expect(() => writer.query("missing")).toThrow(/unknown table/u);
    });

    it("take() with both filter and index runs the filter in JS", async () => {
        expect.assertions(1);

        let now = 1;
        const { writer } = setupWriter({
            clock: () => {
                const value = now;

                now += 1;

                return value;
            },
        });

        await writer.insert("messages", { _id: "a", channelId: "c1", text: "keep", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", channelId: "c1", text: "skip", authorId: "u1" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", channelId: "c1", text: "keep", authorId: "u1" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", "c1"))
            .filter((document) => document["text"] === "keep")
            .take(2);

        expect(rows.map((row) => row["_id"])).toEqual(["a", "c"]);
    });
});

describe("createShardCtxDb — onWrite", () => {
    it("fires after each write with op/table/id/doc", async () => {
        expect.assertions(5);

        const events: Parameters<WriteHook>[0][] = [];
        const { writer } = setupWriter({ idGenerator: () => "m_1", onWrite: (event) => void events.push(event) });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        await writer.patch("m_1", { text: "edit" });
        await writer.replace("m_1", { channelId: "c2", text: "fresh", authorId: "u2" });
        await writer.delete("m_1");

        expect(events.map((event) => event.op)).toEqual(["insert", "update", "update", "delete"]);
        expect(events[0]).toMatchObject({ op: "insert", table: "messages", id: "m_1", doc: { text: "hi" } });
        expect(events[1]).toMatchObject({ op: "update", doc: { text: "edit" } });
        expect(events[3]).toMatchObject({ op: "delete", table: "messages", id: "m_1" });
        expect(events[3]?.doc).toBeUndefined();
    });

    it("is awaited so async hooks settle before the write resolves", async () => {
        expect.assertions(1);

        const order: string[] = [];
        const { writer } = setupWriter({
            idGenerator: () => "m_1",
            onWrite: async () => {
                await Promise.resolve();
                order.push("hook");
            },
        });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        order.push("after");

        expect(order).toEqual(["hook", "after"]);
    });

    it("does not fire when delete targets an unknown id", async () => {
        expect.assertions(1);

        const onWrite = vi.fn<WriteHook>();
        const { writer } = setupWriter({ onWrite });

        await writer.delete("missing");

        expect(onWrite).not.toHaveBeenCalled();
    });

    it("a thrown hook propagates to the caller", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({
            idGenerator: () => "m_1",
            onWrite: () => {
                throw new Error("sync failed");
            },
        });

        await expect(writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" })).rejects.toThrow(/sync failed/u);
    });
});

describe("createShardCtxDb — broadcast", () => {
    it("broadcast callback receives the latest mutation", async () => {
        expect.assertions(4);

        const broadcast = vi.fn<BroadcastDelta>();
        const { writer } = setupWriter({ broadcast, idGenerator: () => "m_1" });

        await writer.insert("messages", { channelId: "c1", text: "hi", authorId: "u1" });
        await writer.patch("m_1", { text: "edit" });
        await writer.delete("m_1");

        expect(broadcast).toHaveBeenCalledTimes(3);
        expect(broadcast.mock.calls[0]![0]).toMatchObject({ op: "insert" });
        expect(broadcast.mock.calls[1]![0]).toMatchObject({ op: "update" });
        expect(broadcast.mock.calls[2]![0]).toMatchObject({ op: "delete" });
    });
});
