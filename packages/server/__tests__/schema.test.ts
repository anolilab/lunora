import { describe, expect, test } from "vitest";

import { defineSchema, defineTable, v } from "../src/index.js";

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
});
