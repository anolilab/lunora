import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, SqlExec, WriteHook } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import messagesSchema from "./_helpers/messages-schema";
import createSqliteExec from "./_helpers/node-sqlite";

/** DDL probes over the real `sqlite_master` catalog — the node:sqlite replacement for the fake's `state.tables`/`state.indexes` inspection. */
const tableExists = (sql: SqlExec, name: string): boolean =>
    sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
const indexExists = (sql: SqlExec, name: string): boolean =>
    sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", name).toArray().length > 0;
const indexIsUnique = (sql: SqlExec, name: string): boolean => {
    const row = sql.exec<{ sql: null | string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", name).toArray()[0];

    return typeof row?.sql === "string" && /\bUNIQUE\b/iu.test(row.sql);
};

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
    sql: SqlExec;
    writer: DatabaseWriterLike;
} => {
    const { sql } = createSqliteExec();
    const deltas: Parameters<BroadcastDelta>[0][] = [];

    runShardMigrations(sql, messagesSchema);

    const writer = createShardContextDatabase({
        broadcast: overrides.broadcast ?? ((delta) => deltas.push(delta)),
        clock: overrides.clock ?? (() => fixedTime),
        idGenerator: overrides.idGenerator,
        onWrite: overrides.onWrite,
        schema: messagesSchema,
        sql,
    });

    return { deltas, sql, writer };
};

describe("runShardMigrations", () => {
    it("creates a SQLite table per non-global schema table", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        runShardMigrations(sql, messagesSchema);

        expect(tableExists(sql, "messages")).toBe(true);
        expect(tableExists(sql, "roomMembers")).toBe(true);
    });

    it("skips tables declared as .global()", () => {
        expect.assertions(1);

        const { sql } = createSqliteExec();

        runShardMigrations(sql, messagesSchema);

        expect(tableExists(sql, "profiles")).toBe(false);
    });

    it("creates indexes prefixed with the table name", () => {
        expect.assertions(3);

        const { sql } = createSqliteExec();

        runShardMigrations(sql, messagesSchema);

        expect(indexExists(sql, "messages_by_channel")).toBe(true);
        expect(indexExists(sql, "messages_by_channel_creation")).toBe(true);
        expect(indexExists(sql, "messages_by_text")).toBe(true);
    });

    it("marks unique indexes with UNIQUE", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        runShardMigrations(sql, messagesSchema);

        expect(indexIsUnique(sql, "messages_by_text")).toBe(true);
        expect(indexIsUnique(sql, "messages_by_channel")).toBe(false);
    });
});

describe("createShardCtxDb — insert/get", () => {
    let context: ReturnType<typeof setupWriter>;

    beforeEach(() => {
        context = setupWriter({ idGenerator: () => "m_1" });
    });

    it("returns the generated id when no _id is supplied", async () => {
        expect.assertions(1);

        const id = await context.writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });

        expect(id).toBe("m_1");
    });

    it("honors a caller-supplied _id", async () => {
        expect.assertions(2);

        const id = await context.writer.insert("messages", { _id: "fixed", authorId: "u1", channelId: "c1", text: "hi" }, { allowExplicitId: true });

        expect(id).toBe("fixed");

        const fetched = await context.writer.get("fixed");

        expect(fetched).toMatchObject({ _id: "fixed", text: "hi" });
    });

    it("stamps _creationTime via the injected clock", async () => {
        expect.assertions(1);

        const id = await context.writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        const fetched = await context.writer.get(id);

        expect(fetched).toMatchObject({ _creationTime: fixedTime });
    });

    it("emits a broadcast delta on insert", async () => {
        expect.assertions(2);

        await context.writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });

        expect(context.deltas).toHaveLength(1);
        expect(context.deltas[0]).toMatchObject({ key: "m_1", op: "insert", table: "messages" });
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

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        await writer.patch("m_1", { text: "edited" });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ channelId: "c1", text: "edited" });
    });

    it("patch throws when the document does not exist", async () => {
        expect.assertions(1);

        const { writer } = setupWriter();

        await expect(writer.patch("missing", { text: "x" })).rejects.toThrow(/document not found/u);
    });

    it("patch throws a descriptive error when a field is explicitly undefined", async () => {
        expect.assertions(2);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });

        await expect(writer.patch("m_1", { text: undefined })).rejects.toThrow(
            "Cannot patch field 'text' to undefined — use null to clear a nullable field, or omit the key to leave it unchanged.",
        );

        // The silent delete must not have happened: the field is untouched.
        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ text: "hi" });
    });

    it("patch sets a nullable field to null (null is preserved, not stripped)", async () => {
        expect.assertions(2);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        await writer.patch("m_1", { text: null });

        const fetched = await writer.get("m_1");

        expect(fetched).toHaveProperty("text", null);
        expect(fetched).toMatchObject({ channelId: "c1" });
    });

    it("patch omitting a key leaves that field unchanged", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        // `text` is not a property of the patch object at all — must be a no-op.
        await writer.patch("m_1", { channelId: "c2" });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ channelId: "c2", text: "hi" });
    });

    it("replace throws a descriptive error when a field is explicitly undefined", async () => {
        expect.assertions(2);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });

        await expect(writer.replace("m_1", { authorId: "u2", channelId: "c2", text: undefined })).rejects.toThrow(
            "Cannot replace field 'text' to undefined — use null to clear a nullable field, or omit the key to leave it unchanged.",
        );

        // The aborted replace must not have mutated the row.
        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ authorId: "u1", channelId: "c1", text: "hi" });
    });

    it("replace overwrites the whole document but keeps the id", async () => {
        expect.assertions(1);

        const { writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        await writer.replace("m_1", { authorId: "u2", channelId: "c2", text: "fresh" });

        const fetched = await writer.get("m_1");

        expect(fetched).toMatchObject({ _id: "m_1", authorId: "u2", channelId: "c2", text: "fresh" });
    });

    it("delete is a no-op when the id is unknown", async () => {
        expect.assertions(1);

        const { deltas, writer } = setupWriter();

        await writer.delete("missing");

        expect(deltas).toHaveLength(0);
    });

    it("delete removes the row and broadcasts a delta", async () => {
        expect.assertions(3);

        const { deltas, writer } = setupWriter({ idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        deltas.length = 0;

        await writer.delete("m_1");

        await expect(writer.get("m_1")).resolves.toBeNull();
        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({ key: "m_1", op: "delete", table: "messages" });
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

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });

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

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "third" }, { allowExplicitId: true });

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

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });

        const row = await writer.query("messages").first();

        expect(row).toMatchObject({ _id: "a" });
    });

    it("filter() runs in JS against the decoded document", async () => {
        expect.assertions(2);

        const { writer } = setupWriter();

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "hello" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "world" }, { allowExplicitId: true });

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

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "hi-a" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c2", text: "hi-b" }, { allowExplicitId: true });

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

        await writer.insert("messages", { _id: "a", authorId: "u1", channelId: "c1", text: "first" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "u1", channelId: "c1", text: "second" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", authorId: "u1", channelId: "c1", text: "third" }, { allowExplicitId: true });

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

        // `text` is a UNIQUE index, so the JS-filter dimension is `authorId` (which repeats); each row keeps a distinct text.
        await writer.insert("messages", { _id: "a", authorId: "keep", channelId: "c1", text: "t-a" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "b", authorId: "skip", channelId: "c1", text: "t-b" }, { allowExplicitId: true });
        await writer.insert("messages", { _id: "c", authorId: "keep", channelId: "c1", text: "t-c" }, { allowExplicitId: true });

        const rows = await writer
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", "c1"))
            .filter((document) => document["authorId"] === "keep")
            .take(2);

        expect(rows.map((row) => row["_id"])).toEqual(["a", "c"]);
    });
});

describe("createShardCtxDb — onWrite", () => {
    it("fires after each write with op/table/id/doc", async () => {
        expect.assertions(5);

        const events: Parameters<WriteHook>[0][] = [];
        const { writer } = setupWriter({
            idGenerator: () => "m_1",
            onWrite: (event) => {
                events.push(event);
            },
        });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        await writer.patch("m_1", { text: "edit" });
        await writer.replace("m_1", { authorId: "u2", channelId: "c2", text: "fresh" });
        await writer.delete("m_1");

        expect(events.map((event) => event.op)).toEqual(["insert", "update", "update", "delete"]);
        expect(events[0]).toMatchObject({ doc: { text: "hi" }, id: "m_1", op: "insert", table: "messages" });
        expect(events[1]).toMatchObject({ doc: { text: "edit" }, op: "update" });
        expect(events[3]).toMatchObject({ id: "m_1", op: "delete", table: "messages" });
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

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
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

        await expect(writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" })).rejects.toThrow(/sync failed/u);
    });
});

describe("createShardCtxDb — broadcast", () => {
    it("broadcast callback receives the latest mutation", async () => {
        expect.assertions(4);

        const broadcast = vi.fn<BroadcastDelta>();
        const { writer } = setupWriter({ broadcast, idGenerator: () => "m_1" });

        await writer.insert("messages", { authorId: "u1", channelId: "c1", text: "hi" });
        await writer.patch("m_1", { text: "edit" });
        await writer.delete("m_1");

        expect(broadcast).toHaveBeenCalledTimes(3);
        expect(broadcast.mock.calls[0]![0]).toMatchObject({ op: "insert" });
        expect(broadcast.mock.calls[1]![0]).toMatchObject({ op: "update" });
        expect(broadcast.mock.calls[2]![0]).toMatchObject({ op: "delete" });
    });
});
