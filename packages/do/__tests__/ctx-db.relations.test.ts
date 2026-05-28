import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises `with`-loading, `_count`, and `onDelete` against a real SQLite
 * engine (workerd can't run in the sandbox). The relation machinery is
 * dialect-agnostic, so proving it here proves the same code path D1 takes.
 */

let harness: ReturnType<typeof createSqliteExec>;

const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const ids = (docs: Array<Record<string, unknown>>): unknown[] => docs.map((doc) => doc["_id"]);

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("with — loading relations", () => {
    const schema: SchemaLike = {
        tables: {
            messages: {
                indexes: [{ fields: ["authorId"], name: "by_author" }],
                relationMap: {
                    author: { field: "authorId", kind: "one", references: "_id", table: "users" },
                    reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
                },
                shape: { authorId: { kind: "string" }, body: { kind: "string" } },
            },
            reactions: {
                indexes: [{ fields: ["messageId"], name: "by_message" }],
                shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
            },
            users: {
                indexes: [],
                relationMap: {
                    messages: { field: "authorId", kind: "many", references: "_id", table: "messages" },
                },
                shape: { name: { kind: "string" } },
            },
        },
    };

    const seed = async (writer: DatabaseWriterLike): Promise<void> => {
        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("users", { _id: "u2", name: "Linus" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });
        await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" });
        await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" });
        await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" });
        await writer.insert("reactions", { _id: "r2", emoji: "🎉", messageId: "m1" });
        await writer.insert("reactions", { _id: "r3", emoji: "🔥", messageId: "m2" });
    };

    test("loads a one relation as Doc | null", async () => {
        const writer = makeWriter(schema);

        await seed(writer);

        const { page } = await writer.findMany("messages", { where: { authorId: "u1" }, with: { author: true } });

        expect(page).toHaveLength(2);
        expect((page[0]!["author"] as Record<string, unknown>)["name"]).toBe("Ada");
        expect((page[1]!["author"] as Record<string, unknown>)["_id"]).toBe("u1");
    });

    test("one relation with no match attaches null", async () => {
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m9", authorId: "ghost", body: "?" });

        const { page } = await writer.findMany("messages", { with: { author: true } });

        expect(page[0]!["author"]).toBeNull();
    });

    test("loads a many relation as Doc[] grouped per parent", async () => {
        const writer = makeWriter(schema);

        await seed(writer);

        const { page } = await writer.findMany("users", { with: { messages: true } });
        const ada = page.find((row) => row["_id"] === "u1")!;
        const linus = page.find((row) => row["_id"] === "u2")!;

        expect(ids(ada["messages"] as Array<Record<string, unknown>>)).toEqual(["m1", "m2"]);
        expect(ids(linus["messages"] as Array<Record<string, unknown>>)).toEqual(["m3"]);
    });

    test("many relation with no children attaches []", async () => {
        const writer = makeWriter(schema);

        await writer.insert("users", { _id: "u3", name: "Loner" });

        const { page } = await writer.findMany("users", { where: { _id: "u3" }, with: { messages: true } });

        expect(page[0]!["messages"]).toEqual([]);
    });

    test("nested with recurses (users → messages → reactions)", async () => {
        const writer = makeWriter(schema);

        await seed(writer);

        const { page } = await writer.findMany("users", { where: { _id: "u1" }, with: { messages: { with: { reactions: true } } } });
        const messages = page[0]!["messages"] as Array<Record<string, unknown>>;
        const m1 = messages.find((row) => row["_id"] === "m1")!;

        expect(ids(m1["reactions"] as Array<Record<string, unknown>>)).toEqual(["r1", "r2"]);
    });

    test("nested where + orderBy + limit apply to a many relation", async () => {
        const writer = makeWriter(schema);

        await seed(writer);

        const { page } = await writer.findMany("messages", {
            where: { _id: "m1" },
            with: { reactions: { limit: 1, orderBy: [{ emoji: "desc" }] } },
        });
        const reactions = page[0]!["reactions"] as Array<Record<string, unknown>>;

        expect(reactions).toHaveLength(1);
    });

    test("_count attaches per-parent aggregate without loading rows", async () => {
        const writer = makeWriter(schema);

        await seed(writer);

        const { page } = await writer.findMany("messages", { orderBy: [{ _id: "asc" }], with: { _count: { reactions: true } } });

        expect((page[0]!["_count"] as Record<string, number>)["reactions"]).toBe(2);
        expect((page[1]!["_count"] as Record<string, number>)["reactions"]).toBe(1);
        expect((page[2]!["_count"] as Record<string, number>)["reactions"]).toBe(0);
        expect(page[0]!["reactions"]).toBeUndefined();
    });

    test("throws on an unknown relation name", async () => {
        const writer = makeWriter(schema);

        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });

        await expect(writer.findMany("messages", { with: { nope: true } })).rejects.toThrow(/unknown relation "nope"/);
    });
});

describe("onDelete", () => {
    const buildSchema = (action: "cascade" | "restrict" | "set null"): SchemaLike => ({
        tables: {
            messages: {
                indexes: [{ fields: ["authorId"], name: "by_author" }],
                relationMap: {
                    author: { field: "authorId", kind: "one", onDelete: action, references: "_id", table: "users" },
                    reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
                },
                shape: { authorId: { kind: "string" }, body: { kind: "string" } },
            },
            reactions: {
                indexes: [{ fields: ["messageId"], name: "by_message" }],
                relationMap: {
                    message: { field: "messageId", kind: "one", onDelete: "cascade", references: "_id", table: "messages" },
                },
                shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
            },
            users: { indexes: [], shape: { name: { kind: "string" } } },
        },
    });

    test("cascade deletes holder rows (and chains recursively)", async () => {
        const writer = makeWriter(buildSchema("cascade"));

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });
        await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" });

        await writer.delete("u1");

        await expect(writer.get("m1")).resolves.toBeNull();
        await expect(writer.get("r1")).resolves.toBeNull();
    });

    test("set null clears the FK on holder rows", async () => {
        const writer = makeWriter(buildSchema("set null"));

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });

        await writer.delete("u1");

        const message = await writer.get("m1");

        expect(message).not.toBeNull();
        expect(message!["authorId"]).toBeNull();
    });

    test("restrict throws when a holder still references the parent", async () => {
        const writer = makeWriter(buildSchema("restrict"));

        await writer.insert("users", { _id: "u1", name: "Ada" });
        await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" });

        await expect(writer.delete("u1")).rejects.toThrow(/still references it/);
        await expect(writer.get("u1")).resolves.not.toBeNull();
    });

    test("restrict allows deletion once no holders remain", async () => {
        const writer = makeWriter(buildSchema("restrict"));

        await writer.insert("users", { _id: "u1", name: "Ada" });

        await writer.delete("u1");

        await expect(writer.get("u1")).resolves.toBeNull();
    });
});

describe("cross-backend guard", () => {
    const schema: SchemaLike = {
        tables: {
            globals: { indexes: [], shape: { value: { kind: "string" } }, shardMode: { kind: "global" } },
            local: {
                indexes: [],
                relationMap: { remote: { field: "ref", kind: "one", references: "_id", table: "globals" } },
                shape: { ref: { kind: "string" } },
                shardMode: { kind: "root" },
            },
        },
    };

    test("throws when a relation crosses the DO↔D1 boundary", async () => {
        const writer = makeWriter(schema);

        await writer.insert("local", { _id: "l1", ref: "g1" });

        await expect(writer.findMany("local", { with: { remote: true } })).rejects.toThrow(/cross-backend relation 'local.remote' not supported/);
    });
});
