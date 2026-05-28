import { Project } from "ts-morph";
import { describe, expect, test } from "vitest";

import { discoverSchema } from "../src/discover-schema.js";
import { emitDataModel } from "../src/emit.js";

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

    test("captures an inline .vectorize() index hoisted into schema.vectorIndexes (Shape A)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema({
                docs: defineTable({
                    body: v.string(),
                    title: v.string(),
                    workspaceId: v.id("workspaces"),
                })
                    .shardBy("workspaceId")
                    .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", metadata: ["title", "workspaceId"], embed }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const docs = schema.tables.find((table) => table.name === "docs");

        expect(docs?.vectorIndexes[0]).toEqual({
            dimensions: 1024,
            field: "body",
            metadata: ["title", "workspaceId"],
            metric: "cosine",
            name: "docs-body",
            table: "docs",
        });
        expect(schema.vectorIndexes).toEqual(docs?.vectorIndexes);
    });

    test("captures a standalone defineVectorIndex entry from the second arg (Shape B)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema(
                {
                    docs: defineTable({ body: v.string(), title: v.string() }).shardBy("body"),
                },
                {
                    "docs-title-and-body": defineVectorIndex({
                        source: { table: "docs", select: (row) => row.title + row.body },
                        dimensions: 768,
                        metric: "euclidean",
                        embed,
                    }),
                },
            );
        `);

        const schema = discoverSchema(project, schemaPath);

        expect(schema.vectorIndexes).toEqual([
            {
                dimensions: 768,
                metric: "euclidean",
                name: "docs-title-and-body",
                table: "docs",
            },
        ]);
    });

    test("captures column modifiers into the field IR (and a chain no longer throws)", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, v } from "@cirrus/server";

            export const schema = defineSchema({
                todos: defineTable({
                    title: v.string().unique(),
                    priority: v.string().unique().default("medium"),
                    createdAt: v.number().$defaultFn(() => Date.now()),
                    updatedAt: v.number().$onUpdateFn(() => Date.now()),
                    note: v.string().nullable(),
                    plain: v.string(),
                }),
            });
        `);

        const schema = discoverSchema(project, schemaPath);
        const todos = schema.tables.find((table) => table.name === "todos");

        expect(todos?.shape.title).toEqual({ column: { notNull: true, unique: true }, kind: "string" });
        expect(todos?.shape.priority).toEqual({ column: { hasDefault: true, notNull: true, unique: true }, kind: "string" });
        expect(todos?.shape.createdAt).toEqual({ column: { hasDefault: true, notNull: true }, kind: "number" });
        expect(todos?.shape.updatedAt).toEqual({ column: { hasOnUpdate: true, notNull: true }, kind: "number" });
        expect(todos?.shape.note).toEqual({ column: { notNull: false }, kind: "string" });
        // A bare validator carries no column metadata.
        expect(todos?.shape.plain).toEqual({ kind: "string" });
    });

    test("emits a VectorIndexName union covering both shapes", () => {
        const { project, schemaPath } = projectWith(`
            import { defineSchema, defineTable, defineVectorIndex, v } from "@cirrus/server";
            import { embed } from "../app/embed";

            export const schema = defineSchema(
                {
                    docs: defineTable({ body: v.string(), title: v.string() })
                        .vectorize("body", { index: "docs-body", dimensions: 1024, metric: "cosine", embed }),
                },
                {
                    "docs-title": defineVectorIndex({
                        source: { table: "docs", select: (row) => row.title },
                        dimensions: 1024,
                        metric: "cosine",
                        embed,
                    }),
                },
            );
        `);

        const schema = discoverSchema(project, schemaPath);
        const dataModel = emitDataModel(schema);

        expect(dataModel).toContain('export type VectorIndexName = "docs-body" | "docs-title";');
    });
});
