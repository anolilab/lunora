import { Project } from "ts-morph";
import { describe, expect, test } from "vitest";

import { discoverSchema } from "../src/discoverSchema.js";

/**
 * Build a fresh in-memory project hosting a `schema.ts` with the given source.
 * Avoids touching disk so each case stays hermetic.
 */
const projectWith = (schemaSource: string): { project: Project; schemaPath: string } => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/cirrus/schema.ts";

    project.createSourceFile(schemaPath, schemaSource);

    return { project, schemaPath };
};

describe("discoverSchema", () => {
    test("captures searchIndex name + field + filterFields", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                messages: defineTable({
                    channelId: v.id("channels"),
                    text: v.string(),
                })
                    .searchIndex("by_text", { field: "text", filterFields: ["channelId"] }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const messages = schema.tables.find((table) => table.name === "messages");

        expect(messages).toBeDefined();
        expect(messages?.searchIndexes).toHaveLength(1);
        expect(messages?.searchIndexes[0]).toEqual({
            field: "text",
            filterFields: ["channelId"],
            name: "by_text",
        });
    });

    test("searchIndex without filterFields leaves the field undefined (not an empty array)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                docs: defineTable({ body: v.string() }).searchIndex("by_body", { field: "body" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "docs");

        expect(docs?.searchIndexes[0]).toMatchObject({ field: "body", name: "by_body" });
        expect(docs?.searchIndexes[0]?.filterFields).toBeUndefined();
    });

    test("tables without searchIndex calls expose an empty searchIndexes array", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.tables[0]?.searchIndexes).toEqual([]);
    });

    test("indexes, shardBy and searchIndex coexist on the same table", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                messages: defineTable({
                    channelId: v.id("channels"),
                    text: v.string(),
                })
                    .shardBy("channelId")
                    .index("by_channel", ["channelId"])
                    .searchIndex("by_text", { field: "text" }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const messages = schema.tables[0];

        expect(messages?.shardMode).toEqual({ field: "channelId", kind: "shardBy" });
        expect(messages?.indexes).toEqual([{ fields: ["channelId"], name: "by_channel", unique: false }]);
        expect(messages?.searchIndexes[0]).toMatchObject({ field: "text", name: "by_text" });
    });
});
