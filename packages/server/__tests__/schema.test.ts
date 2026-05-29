import { describe, expect, test } from "vitest";

import { defineAggregateIndex, defineRankIndex, defineSchema, defineTable, defineVectorIndex, v } from "../src/index.js";

describe("defineTable", () => {
    test("returns a table definition with shape and default __root__ shard mode", () => {
        const messages = defineTable({
            text: v.string(),
            userId: v.id("users"),
        });

        expect(messages.shape.text.kind).toBe("string");
        expect(messages.shardMode).toEqual({ kind: "root" });
        expect(messages.indexes).toEqual([]);
        expect(messages.searchIndexes).toEqual([]);
    });

    test(".index appends an index definition", () => {
        const messages = defineTable({ channelId: v.id("channels"), createdAt: v.number() })
            .index("by_channel", ["channelId"])
            .index("by_channel_time", ["channelId", "createdAt"], { unique: true });

        expect(messages.indexes).toHaveLength(2);
        expect(messages.indexes[0]).toMatchObject({ fields: ["channelId"], name: "by_channel", unique: false });
        expect(messages.indexes[1]).toMatchObject({ fields: ["channelId", "createdAt"], name: "by_channel_time", unique: true });
    });

    test(".searchIndex appends a search index definition", () => {
        const documents = defineTable({ body: v.string(), workspaceId: v.id("workspaces") }).searchIndex("by_body", {
            field: "body",
            filterFields: ["workspaceId"],
        });

        expect(documents.searchIndexes).toHaveLength(1);
        expect(documents.searchIndexes[0]).toMatchObject({ field: "body", filterFields: ["workspaceId"], name: "by_body" });
    });

    test(".shardBy marks the table as shard-local", () => {
        const documents = defineTable({ body: v.string(), workspaceId: v.id("workspaces") }).shardBy("workspaceId");

        expect(documents.shardMode).toEqual({ field: "workspaceId", kind: "shardBy" });
    });

    test(".global marks the table as global", () => {
        const users = defineTable({ email: v.string() }).global();

        expect(users.shardMode).toEqual({ kind: "global" });
    });

    test("table without .vectorize exposes an empty vectorIndexes array", () => {
        const docs = defineTable({ body: v.string() });

        expect(docs.vectorIndexes).toEqual([]);
    });

    test(".vectorize appends an inline vector index (Shape A)", () => {
        const embed = (text: string): ReadonlyArray<number> => [text.length];
        const docs = defineTable({ body: v.string(), title: v.string(), workspaceId: v.id("workspaces") })
            .shardBy("workspaceId")
            .vectorize("body", { dimensions: 1024, embed, index: "docs-body", metadata: ["title", "workspaceId"], metric: "cosine" });

        expect(docs.vectorIndexes).toHaveLength(1);
        expect(docs.vectorIndexes[0]).toMatchObject({
            dimensions: 1024,
            field: "body",
            metadata: ["title", "workspaceId"],
            metric: "cosine",
            name: "docs-body",
        });
        expect(docs.vectorIndexes[0]?.embed).toBe(embed);
    });

    test(".aggregateIndex defaults to count and stashes the by-tuple", () => {
        const todos = defineTable({ archived: v.boolean(), projectId: v.string() })
            .aggregateIndex("byProject", { by: ["projectId"] })
            .aggregateIndex("activeByProject", { by: ["projectId"], where: { archived: false } });

        expect(todos.aggregateIndexes).toHaveLength(2);
        expect(todos.aggregateIndexes[0]).toMatchObject({ by: ["projectId"], name: "byProject", op: "count" });
        expect(todos.aggregateIndexes[1]).toMatchObject({ name: "activeByProject", where: { archived: false } });

        // `on` is filled in by defineSchema once the table is keyed.
        const schema = defineSchema({ todos });

        expect(schema.tables.todos.aggregateIndexes[0]?.on).toBe("todos");
        expect(schema.tables.todos.aggregateIndexes[1]?.on).toBe("todos");
    });

    test(".aggregateIndex(non-count) requires a field", () => {
        const builder = defineTable({ seq: v.number() });

        expect(() => builder.aggregateIndex("seqSum", { op: "sum" })).toThrow(/requires a "field"/);
    });

    test(".rankIndex stashes name, sortBy (asc default) + partitionBy + where", () => {
        const messages = defineTable({ archived: v.boolean(), channelId: v.string(), createdAt: v.number(), score: v.number() })
            .rankIndex("byChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }] })
            .rankIndex("leaderboard", { sortBy: [{ direction: "desc", field: "score" }] })
            .rankIndex("activeByChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }], where: { archived: false } });

        expect(messages.rankIndexes).toHaveLength(3);
        expect(messages.rankIndexes[0]).toMatchObject({
            name: "byChannel",
            partitionBy: ["channelId"],
            sortBy: [{ direction: "asc", field: "createdAt" }],
        });
        expect(messages.rankIndexes[1]).toMatchObject({
            name: "leaderboard",
            sortBy: [{ direction: "desc", field: "score" }],
        });
        expect(messages.rankIndexes[2]).toMatchObject({
            name: "activeByChannel",
            where: { archived: false },
        });

        // `on` is filled in by defineSchema once the table is keyed.
        const schema = defineSchema({ messages });

        expect(schema.tables.messages.rankIndexes[0]?.on).toBe("messages");
        expect(schema.tables.messages.rankIndexes[1]?.on).toBe("messages");
    });

    test(".rankIndex requires a non-empty sortBy", () => {
        const builder = defineTable({ score: v.number() });

        expect(() => builder.rankIndex("bad", { sortBy: [] })).toThrow(/sortBy/);
    });

    test("builder chains return the same instance", () => {
        const builder = defineTable({ a: v.string() });
        const chained = builder.index("by_a", ["a"]).shardBy("a");

        expect(chained).toBe(builder);
    });
});

describe("defineSchema", () => {
    test("collects tables into a Schema", () => {
        const schema = defineSchema({
            messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
            users: defineTable({ email: v.string() }).global().index("by_email", ["email"], { unique: true }),
        });

        expect(Object.keys(schema.tables)).toEqual(["messages", "users"]);
        expect(schema.tables.users.shardMode).toEqual({ kind: "global" });
        expect(schema.tables.messages.shardMode).toEqual({ field: "channelId", kind: "shardBy" });
    });

    test("defaults vectorIndexes to an empty object when the second arg is omitted", () => {
        const schema = defineSchema({ users: defineTable({ email: v.string() }) });

        expect(schema.vectorIndexes).toEqual({});
    });

    test("standalone defineAggregateIndex entries fold onto the owning table", () => {
        const schema = defineSchema(
            { todos: defineTable({ archived: v.boolean(), projectId: v.string() }) },
            {},
            {
                byProject: defineAggregateIndex("byProject", { by: ["projectId"], on: "todos" }),
            },
        );

        expect(schema.tables.todos.aggregateIndexes).toHaveLength(1);
        expect(schema.tables.todos.aggregateIndexes[0]).toMatchObject({ by: ["projectId"], name: "byProject", on: "todos", op: "count" });
    });

    test("standalone defineAggregateIndex throws when `on` table is unknown", () => {
        expect(() =>
            defineSchema({ todos: defineTable({ projectId: v.string() }) }, {}, { stray: defineAggregateIndex("stray", { by: ["projectId"], on: "missing" }) }),
        ).toThrow(/unknown table/);
    });

    test("standalone defineRankIndex entries fold onto the owning table", () => {
        const schema = defineSchema(
            { messages: defineTable({ channelId: v.string(), createdAt: v.number() }) },
            {},
            {},
            {
                byChannel: defineRankIndex("byChannel", { partitionBy: ["channelId"], sortBy: [{ field: "createdAt" }], table: "messages" }),
            },
        );

        expect(schema.tables.messages.rankIndexes).toHaveLength(1);
        expect(schema.tables.messages.rankIndexes[0]).toMatchObject({
            name: "byChannel",
            on: "messages",
            partitionBy: ["channelId"],
            sortBy: [{ direction: "asc", field: "createdAt" }],
        });
    });

    test("standalone defineRankIndex throws when `table` is unknown", () => {
        expect(() =>
            defineSchema(
                { messages: defineTable({ createdAt: v.number() }) },
                {},
                {},
                { stray: defineRankIndex("stray", { sortBy: [{ field: "createdAt" }], table: "missing" }) },
            ),
        ).toThrow(/unknown table/);
    });

    test("defineRankIndex requires a non-empty sortBy", () => {
        expect(() => defineRankIndex("bad", { sortBy: [], table: "messages" })).toThrow(/sortBy/);
    });

    test("registers standalone defineVectorIndex entries from the second arg (Shape B)", () => {
        const embed = async (text: string): Promise<ReadonlyArray<number>> => [text.length];
        const schema = defineSchema(
            { docs: defineTable({ body: v.string(), title: v.string() }) },
            {
                "docs-title-and-body": defineVectorIndex({
                    dimensions: 1024,
                    embed,
                    metric: "cosine",
                    source: { select: (row) => `${row.title}\n\n${row.body}`, table: "docs" },
                }),
            },
        );

        const index = schema.vectorIndexes["docs-title-and-body"];

        expect(index).toMatchObject({ dimensions: 1024, kind: "vectorIndex", metric: "cosine", table: "docs" });
        expect(index?.select({ body: "B", title: "T" })).toBe("T\n\nB");
    });
});
